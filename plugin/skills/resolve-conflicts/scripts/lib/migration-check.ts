import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { readBlob } from "./git.ts";
import {
  duplicateSequences,
  type MigrationPlan,
  sources,
} from "./migration-plan.ts";
import { sameStage } from "./provenance.ts";
import type { Stage } from "./snapshot.ts";

type Tree = ReadonlyMap<string, Stage>;
type Problem = { path: string; message: string };
type Check = { problems: Problem[]; verified: Set<string> };

interface JournalEntry {
  tag: string;
  idx: number;
  when: number;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  return (
    isRecord(value) &&
    typeof value.tag === "string" &&
    typeof value.idx === "number" &&
    typeof value.when === "number" &&
    Number.isSafeInteger(value.when)
  );
}

function drizzleEntries(entries: unknown[]): JournalEntry[] | null {
  const result: JournalEntry[] = [];
  for (const [idx, entry] of entries.entries()) {
    if (!isJournalEntry(entry) || entry.idx !== idx) return null;
    result.push(entry);
  }
  return result;
}

/** An ordered JSON filename list, or legacy Drizzle's ordered tag entries. */
interface Journal {
  names: string[];
  entries: JournalEntry[] | null;
}

function decodeJournal(text: string): Journal | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    swallow(
      err,
      "an invalid migration journal is reported by the resolution check",
    );
    return null;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return { names: value, entries: null };
  if (!isRecord(value) || !Array.isArray(value.entries)) return null;
  const entries = drizzleEntries(value.entries);
  return entries === null
    ? null
    : { names: entries.map(({ tag }) => `${tag}.sql`), entries };
}

function isRegular(stage: Stage | undefined): stage is Stage {
  return stage?.mode === "100644" || stage?.mode === "100755";
}

function readJournal(root: string, stage: Stage | undefined): Journal | null {
  return isRegular(stage) ? decodeJournal(readBlob(root, stage.blob)) : null;
}

/**
 * The journal the resolution must stage: the integration journal's names as
 * committed, whatever their order, then every other staged migration in
 * sequence order. Without an integration journal, every staged migration in
 * sequence order.
 */
function expectedNames(
  group: MigrationPlan["group"],
  staged: Tree,
  integration: { journal: Journal; tree: Tree } | null,
): string[] {
  const given = integration?.journal.names ?? [];
  const listed = new Set(given);
  const committed = new Set(
    integration === null
      ? []
      : sources(group, integration.tree).map(({ path }) => path),
  );
  const rest = sources(group, staged)
    .filter(({ path }) => !committed.has(path))
    .map(({ path }) => posix.basename(path))
    .filter((name) => !listed.has(name));
  return [...given, ...rest];
}

const ORDER_MESSAGE =
  "migration journal must list each staged migration in sequence order: regenerate the journal and snapshots";
const PREFIX_ORDER_MESSAGE =
  "migration journal must keep the integration journal's entries as committed, then list each staged migration the integration side does not commit in sequence order: regenerate the journal and snapshots";

/** Each migration the integration journal lists and commits, but the resolution dropped. */
function droppedMigrations(
  group: MigrationPlan["group"],
  listed: string[],
  staged: Tree,
  integrationTree: Tree,
): Problem[] {
  const names = (tree: Tree) =>
    new Set(sources(group, tree).map(({ path }) => posix.basename(path)));
  const kept = names(staged);
  const committed = names(integrationTree);
  return listed
    .filter((name) => committed.has(name) && !kept.has(name))
    .map((name) => ({
      path: posix.join(group.directory, name),
      message:
        "migration the integration journal lists is missing: preserve the committed migration",
    }));
}

/** The integration journal: `undefined` when it has none, `null` when unreadable. */
function committedJournal(
  root: string,
  group: MigrationPlan["group"],
  tree: Tree,
): Journal | null | undefined {
  const stage = tree.get(group.journal);
  return stage === undefined ? undefined : readJournal(root, stage);
}

function checkJournal(
  root: string,
  plan: MigrationPlan,
  staged: Tree,
  integrationTree: Tree,
): Problem[] {
  const { group } = plan;
  const problems = duplicateSequences(
    sources(group, staged),
    "the staged tree",
  );
  const actual = readJournal(root, staged.get(group.journal));
  const integration = committedJournal(root, group, integrationTree);
  if (integration === null)
    return [
      ...problems,
      {
        path: group.journal,
        message:
          "cannot verify the committed integration journal: repair its format before resolving the sequence",
      },
    ];
  const given =
    integration === undefined
      ? null
      : { journal: integration, tree: integrationTree };
  if (!isDeepStrictEqual(actual?.names, expectedNames(group, staged, given)))
    problems.push({
      path: group.journal,
      message: given === null ? ORDER_MESSAGE : PREFIX_ORDER_MESSAGE,
    });
  problems.push(
    ...droppedMigrations(
      group,
      integration?.names ?? [],
      staged,
      integrationTree,
    ),
  );
  const problem = timestampProblem(actual, integration);
  if (problem !== null)
    problems.push({ path: group.journal, message: problem });
  return problems;
}

const WATERMARK_MESSAGE =
  "preserve the integration journal entries and append migrations after their timestamps";

function increasing(entries: JournalEntry[], after: number): boolean {
  let previous = after;
  for (const { when } of entries) {
    if (when <= previous) return false;
    previous = when;
  }
  return true;
}

/**
 * Drizzle uses the applied journal's timestamps as the migration watermark.
 * The integration entries are taken as committed, in their order and with
 * their timestamps; each appended entry must be later than every one of
 * them and than the entry before it.
 */
function timestampProblem(
  actual: Journal | null,
  integration: Journal | undefined,
): string | null {
  const given = integration?.entries ?? null;
  const entries = actual?.entries ?? null;
  if (given === null)
    return increasing(entries ?? [], -Infinity)
      ? null
      : "migration journal timestamps must increase strictly: regenerate the journal and snapshots";
  if (
    entries === null ||
    !isDeepStrictEqual(given, entries.slice(0, given.length))
  )
    return WATERMARK_MESSAGE;
  const latest = given.reduce(
    (max, { when }) => Math.max(max, when),
    -Infinity,
  );
  return increasing(entries.slice(given.length), latest)
    ? null
    : WATERMARK_MESSAGE;
}

function checkSources(plan: MigrationPlan, staged: Tree, check: Check): void {
  for (const { stage, path, target } of plan.required) {
    if (!isRegular(stage) || !sameStage(stage, staged.get(target)))
      check.problems.push({
        path: target,
        message: `migration ${path} is missing or changed at ${target}: preserve the committed migration`,
      });
    else if (path !== target) check.verified.add(target);
  }
}

function checkOutputs(plan: MigrationPlan, staged: Tree, check: Check): void {
  for (const [path, original] of plan.outputs) {
    const stage = staged.get(path);
    if (!isRegular(stage))
      check.problems.push({
        path,
        message: "regenerated migration output is missing",
      });
    else if (original !== null && !sameStage(original, stage))
      check.problems.push({
        path,
        message:
          "integration snapshot was changed: restore its committed version",
      });
    else if (plan.moves.length > 0 || plan.regenerate.includes(path))
      check.verified.add(path);
  }
}

/**
 * Check the whole staged migration sequence even if a migration merged
 * cleanly, or its recorded decision acknowledges a deletion. Only the
 * planned new paths and generated outputs may bypass ordinary provenance.
 */
export function checkMigrations(
  root: string,
  plans: MigrationPlan[],
  staged: Tree,
  integration: Tree,
): Check {
  const check: Check = { problems: [], verified: new Set() };
  for (const plan of plans) {
    check.problems.push(...plan.problems);
    for (const path of plan.remove)
      if (staged.has(path))
        check.problems.push({
          path,
          message:
            "obsolete migration or snapshot still staged after renumbering",
        });
    checkSources(plan, staged, check);
    check.problems.push(...checkJournal(root, plan, staged, integration));
    checkOutputs(plan, staged, check);
  }
  return check;
}
