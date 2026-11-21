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
  let previousWhen = -Infinity;
  for (const [idx, entry] of entries.entries()) {
    if (
      !isJournalEntry(entry) ||
      entry.idx !== idx ||
      entry.when <= previousWhen
    )
      return null;
    result.push(entry);
    previousWhen = entry.when;
  }
  return result;
}

/** An ordered JSON filename list, or legacy Drizzle's ordered tag entries. */
function decodeJournal(text: string): {
  names: string[];
  entries: JournalEntry[] | null;
} | null {
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

function checkJournal(
  root: string,
  plan: MigrationPlan,
  staged: Tree,
  committed: Stage | undefined,
): Problem[] {
  const files = sources(plan.group, staged);
  const problems = duplicateSequences(files, "the staged tree");
  const journal = staged.get(plan.group.journal);
  const actual = isRegular(journal)
    ? decodeJournal(readBlob(root, journal.blob))
    : null;
  if (
    actual?.names.length !== files.length ||
    files.some(({ path }, i) => posix.basename(path) !== actual.names[i])
  )
    problems.push({
      path: plan.group.journal,
      message:
        "migration journal must list each staged migration in sequence order: regenerate the journal and snapshots",
    });
  // Drizzle uses the applied journal's timestamp as the migration watermark.
  // Preserve integration's original prefix, then validate the appended
  // timestamps against it through decodeJournal's strict ordering check.
  const integration = isRegular(committed)
    ? decodeJournal(readBlob(root, committed.blob))?.entries
    : null;
  if (
    integration &&
    !isDeepStrictEqual(
      integration,
      actual?.entries?.slice(0, integration.length),
    )
  )
    problems.push({
      path: plan.group.journal,
      message:
        "preserve the integration journal entries and append migrations after their timestamps",
    });
  return problems;
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
    check.problems.push(
      ...checkJournal(root, plan, staged, integration.get(plan.group.journal)),
    );
    checkOutputs(plan, staged, check);
  }
  return check;
}
