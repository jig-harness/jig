/**
 * Resolve the spec a work item links: the requirements, acceptance criteria
 * and tasks its body carries or names, each with an id qualified by its
 * source. Read-only: it writes nothing and fetches no web link.
 *
 * Input: the issue JSON `do-item`'s `get_issue.ts` prints (its body is
 * `description`; `body`, as `gh issue view` names it, is read too).
 * Output: `{sources, requirements, acceptance, tasks, unresolved}`.
 *
 * Usage:
 *     bun resolve.ts [--input <issue.json>] [--summary]
 *
 * Without `--input` the issue is read from standard input. The repository is
 * the one the working directory is in (`JIG_CONSUMER_ROOT` overrides it, as
 * for every plugin script); no argument names it, so nothing on the command
 * line can move the boundary the reads are held inside. `--summary` prints
 * the result as text for a person instead of JSON: the counts, every
 * requirement, criterion and task with its key, the sources and the
 * unresolved references.
 *
 * Each adapter's `detect` and `read` has a deadline (30 seconds): one that
 * has not answered by then is given up on, its signal aborted, and the
 * reference reported as unresolved, so a hung tool cannot stall a pickup.
 *
 * Exit codes: 0 resolved (an empty result included), 2 usage or an input
 * that is not an issue, 1 a `specs` configuration the resolver cannot use.
 *
 * One source per artifact: a source is its canonical reference (a body
 * section's `#body/<heading>`, a file's path relative to the root), so one
 * artifact reached twice is one source with both findings in `evidence`.
 * Every entry's `key` is that reference, `#`, and its id within the source.
 */
import { parseArgs } from "node:util";
import { fail, readStdinAll, runMain } from "../cli.ts";
import { consumerRoot } from "../consumer.ts";
import { isRecord } from "../guards.ts";
import { INVALID_JSON_INPUT, readJsonInput } from "../json-input.ts";
import type { AdapterRead, SpecAdapter, SpecReference } from "./adapter.ts";
import { readSpecsConfig, type SpecsConfig } from "./config.ts";
import { checkedFiles } from "./files.ts";
import {
  bodyMentions,
  bodySections,
  type Checked,
  checkReference,
  claimant,
  sectionReferences,
} from "./references.ts";
import { ADAPTERS } from "./registry.ts";

export interface SpecSource {
  adapter: string;
  ref: string;
  evidence: string[];
}

export interface Requirement {
  id: string;
  key: string;
  text: string;
  source: number;
}

export interface Criterion {
  id: string;
  key: string;
  text: string;
  /** The key of the requirement it serves, or `null`. */
  requirement: string | null;
  source: number;
}

export interface Task {
  id: string;
  key: string;
  text: string;
  done: boolean;
  source: number;
}

export interface SpecResult {
  sources: SpecSource[];
  requirements: Requirement[];
  acceptance: Criterion[];
  tasks: Task[];
  /** Each reference that was not read, with the reason: `<reference> (<reason>)`. */
  unresolved: string[];
}

export interface ResolveOptions {
  /** The adapters there are; the registry by default. */
  registry?: readonly SpecAdapter[];
  /** The `specs` configuration; read from the repository by default. */
  config?: SpecsConfig;
  env?: Record<string, string | undefined>;
  /** How long each adapter call may take, in milliseconds; 30 seconds by default. */
  deadlineMs?: number;
}

const DEADLINE_MS = 30_000;

/** `run`'s answer, or a rejection once `ms` pass, its signal aborted. */
async function withDeadline<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${ms / 1000} seconds`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

const reasonOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The issue's body: `description`, else `body`, else empty. */
function issueBody(issue: Record<string, unknown>): string {
  for (const field of ["description", "body"])
    if (typeof issue[field] === "string") return issue[field] as string;
  return "";
}

/**
 * The adapters to run, in order: the configured ones, or every one whose
 * layout is present. One whose `detect` fails or misses its deadline is
 * left out, and reported in that order.
 */
async function enabledAdapters(
  registry: readonly SpecAdapter[],
  config: SpecsConfig,
  root: string,
  deadlineMs: number,
): Promise<{ adapters: SpecAdapter[]; unresolved: string[] }> {
  const chosen =
    config.adapters === null
      ? [
          ...registry.filter((a) => a.name !== "body"),
          ...registry.filter((a) => a.name === "body"),
        ]
      : config.adapters.flatMap((name) =>
          registry.filter((a) => a.name === name),
        );
  const answers = await Promise.all(
    chosen.map((a) =>
      withDeadline(deadlineMs, (signal) => a.detect(root, signal)).then(
        (present) => ({ present, failure: null }),
        (err: unknown) => ({
          present: false,
          failure: `${a.name} adapter (could not tell whether its layout is present: ${reasonOf(err)})`,
        }),
      ),
    ),
  );
  return {
    adapters: chosen.filter((_, i) => answers[i]?.present),
    unresolved: answers.flatMap((a) => (a.failure === null ? [] : [a.failure])),
  };
}

/** An id `lists` give to more than one entry, or `null`. */
function sharedId(lists: AdapterRead): string | null {
  const seen = new Set<string>();
  for (const { id } of [
    ...lists.requirements,
    ...lists.acceptance,
    ...lists.tasks,
  ]) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

interface Found {
  adapter: SpecAdapter;
  source: SpecSource;
  reference: SpecReference;
  /** What the reference's file checks left out, once the adapter has read it. */
  refused: readonly string[];
}

/**
 * Every reference the body makes, checked, each check given up on at the
 * deadline; the refused ones as unresolved lines.
 */
async function findReferences(
  body: string,
  root: string,
  adapters: readonly SpecAdapter[],
  config: SpecsConfig,
  deadlineMs: number,
): Promise<{ found: Found[]; unresolved: string[] }> {
  const found = new Map<string, Found>();
  const unresolved: string[] = [];
  const add = (f: Found, evidence: string) => {
    const known = found.get(f.source.ref);
    const entry = known ?? f;
    if (!entry.source.evidence.includes(evidence))
      entry.source.evidence.push(evidence);
    found.set(f.source.ref, entry);
  };
  const reader = adapters.find((a) => a.name === "body");
  const candidates: string[] = [];
  for (const section of bodySections(body, config.bodySection)) {
    const ref = `#body/${section.heading}`;
    if (reader)
      add(
        {
          adapter: reader,
          source: { adapter: reader.name, ref, evidence: [] },
          reference: {
            kind: "body",
            ref,
            section: section.kind,
            text: section.text,
            lines: section.lines,
          },
          refused: [],
        },
        "section",
      );
    if (section.kind === "spec")
      candidates.push(...sectionReferences(section.lines));
  }
  for (const mention of bodyMentions(body))
    if (claimant(adapters, mention) !== null) candidates.push(mention);
  for (const candidate of new Set(candidates)) {
    let checked: Checked;
    try {
      checked = await withDeadline(deadlineMs, (signal) =>
        checkReference(candidate, root, adapters, signal),
      );
    } catch (err) {
      unresolved.push(`${candidate} (could not be checked: ${reasonOf(err)})`);
      continue;
    }
    if (!checked.ok) {
      unresolved.push(`${candidate} (${checked.reason})`);
      continue;
    }
    const files = checkedFiles(checked, root);
    add(
      {
        adapter: checked.adapter,
        source: {
          adapter: checked.adapter.name,
          ref: checked.ref,
          evidence: [],
        },
        reference: { kind: "file", ref: checked.ref, files },
        refused: files.refused,
      },
      "body link",
    );
  }
  return { found: [...found.values()], unresolved };
}

/** Qualify each adapter's ids by its source, and link criteria to requirements by key. */
function qualify(
  read: { source: SpecSource; lists: AdapterRead }[],
): Omit<SpecResult, "unresolved"> {
  const result: Omit<SpecResult, "unresolved"> = {
    sources: [],
    requirements: [],
    acceptance: [],
    tasks: [],
  };
  const keyOf = (i: number, id: string) => `${read[i]?.source.ref}#${id}`;
  read.forEach(({ source, lists }, i) => {
    result.sources.push(source);
    for (const r of lists.requirements)
      result.requirements.push({
        id: r.id,
        key: keyOf(i, r.id),
        text: r.text,
        source: i,
      });
    for (const t of lists.tasks)
      result.tasks.push({
        id: t.id,
        key: keyOf(i, t.id),
        text: t.text,
        done: t.done,
        source: i,
      });
  });
  read.forEach(({ lists }, i) => {
    for (const c of lists.acceptance) {
      let requirement: string | null = null;
      if (c.requirement !== null) {
        const own = result.requirements.find(
          (r) => r.source === i && r.id === c.requirement,
        );
        const anywhere = result.requirements.filter(
          (r) => r.id === c.requirement,
        );
        requirement =
          own?.key ??
          (anywhere.length === 1 ? (anywhere[0]?.key ?? null) : null);
      }
      result.acceptance.push({
        id: c.id,
        key: keyOf(i, c.id),
        text: c.text,
        requirement,
        source: i,
      });
    }
  });
  return result;
}

/** Resolve what `issue` links, reading only inside `root`. */
export async function resolveSpec(
  issue: Record<string, unknown>,
  root: string,
  options: ResolveOptions = {},
): Promise<SpecResult> {
  const registry = options.registry ?? ADAPTERS;
  const config =
    options.config ??
    readSpecsConfig(
      root,
      registry.map((a) => a.name),
      options.env,
    );
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const enabled = await enabledAdapters(registry, config, root, deadlineMs);
  const { found, unresolved } = await findReferences(
    issueBody(issue),
    root,
    enabled.adapters,
    config,
    deadlineMs,
  );
  unresolved.unshift(...enabled.unresolved);
  const read: { source: SpecSource; lists: AdapterRead }[] = [];
  for (const f of found) {
    let lists: AdapterRead;
    try {
      lists = await withDeadline(deadlineMs, (signal) =>
        f.adapter.read(f.reference, signal),
      );
    } catch (err) {
      unresolved.push(
        `${f.source.ref} (${f.adapter.name} could not read it: ${reasonOf(err)})`,
      );
      continue;
    } finally {
      unresolved.push(...f.refused);
    }
    const shared = sharedId(lists);
    if (shared === null) read.push({ source: f.source, lists });
    else
      unresolved.push(
        `${f.source.ref} (${f.adapter.name} gave the id ${shared} to more than one entry)`,
      );
  }
  return { ...qualify(read), unresolved };
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** One titled list of entries, or nothing when there are none. */
function listed(title: string, items: string[]): string[] {
  return items.length === 0 ? [] : [`${title}:`, ...items];
}

/**
 * The result as text for a person: counts, every entry with its key, the
 * sources and the unresolved references.
 */
export function summary(result: SpecResult): string {
  const lines = [
    `Spec: ${plural(result.sources.length, "source", "sources")}, ${plural(result.requirements.length, "requirement", "requirements")}, ${plural(result.acceptance.length, "acceptance criterion", "acceptance criteria")}, ${plural(result.tasks.length, "task", "tasks")}`,
    ...listed(
      "Requirements",
      result.requirements.map((r) => `- ${r.key}: ${r.text}`),
    ),
    ...listed(
      "Acceptance criteria",
      result.acceptance.map(
        (c) =>
          `- ${c.key}: ${c.text}${c.requirement === null ? "" : ` (serves ${c.requirement})`}`,
      ),
    ),
    ...listed(
      "Tasks",
      result.tasks.map((t) => `- [${t.done ? "x" : " "}] ${t.key}: ${t.text}`),
    ),
    ...listed(
      "Sources",
      result.sources.map(
        (s) => `- ${s.ref} (${s.adapter}: ${s.evidence.join(", ")})`,
      ),
    ),
  ];
  if (result.unresolved.length > 0)
    lines.push("Unresolved:", ...result.unresolved.map((u) => `- ${u}`));
  return lines.join("\n");
}

const USAGE = "usage: resolve.ts [--input <issue.json>] [--summary]";

interface Flags {
  input?: string;
  summary?: boolean;
}

function flags(argv: string[]): Flags {
  try {
    return parseArgs({
      args: argv,
      options: {
        input: { type: "string" },
        summary: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch (err) {
    fail(2, err instanceof Error ? err.message : String(err), USAGE);
  }
}

/** The issue to resolve, or the exit that refuses the input. */
async function readIssue(
  path: string | undefined,
): Promise<Record<string, unknown>> {
  const issue = await readJsonInput(path, readStdinAll);
  if (issue === INVALID_JSON_INPUT) fail(2);
  if (!isRecord(issue) || issue.found === false)
    fail(
      2,
      "the input is not an issue: pass the JSON get_issue.ts prints for a found issue",
      USAGE,
    );
  return issue;
}

async function main(argv: string[]): Promise<number> {
  const values = flags(argv);
  const issue = await readIssue(values.input);
  let result: SpecResult;
  try {
    result = await resolveSpec(issue, consumerRoot());
  } catch (err) {
    fail(1, reasonOf(err));
  }
  console.log(
    values.summary ? summary(result) : JSON.stringify(result, null, 2),
  );
  return 0;
}

if (import.meta.main) runMain("resolve.ts", () => main(process.argv.slice(2)));
