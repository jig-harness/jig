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
 *     bun resolve.ts [--input <issue.json>] [--root <dir>] [--summary]
 *
 * Without `--input` the issue is read from standard input; `--root` defaults
 * to the repository the working directory is in. `--summary` prints the
 * counts, the sources and the unresolved references as text instead of JSON.
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
import {
  bodyMentions,
  bodySections,
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
}

/** The issue's body: `description`, else `body`, else empty. */
function issueBody(issue: Record<string, unknown>): string {
  for (const field of ["description", "body"])
    if (typeof issue[field] === "string") return issue[field] as string;
  return "";
}

/** The adapters to run, in order: the configured ones, or every one whose layout is present. */
async function enabledAdapters(
  registry: readonly SpecAdapter[],
  config: SpecsConfig,
  root: string,
): Promise<SpecAdapter[]> {
  const chosen =
    config.adapters === null
      ? [
          ...registry.filter((a) => a.name !== "body"),
          ...registry.filter((a) => a.name === "body"),
        ]
      : config.adapters.flatMap((name) =>
          registry.filter((a) => a.name === name),
        );
  const present = await Promise.all(chosen.map((a) => a.detect(root)));
  return chosen.filter((_, i) => present[i]);
}

interface Found {
  adapter: SpecAdapter;
  source: SpecSource;
  reference: SpecReference;
}

/** Every reference the body makes, checked; the refused ones as unresolved lines. */
function findReferences(
  body: string,
  root: string,
  adapters: readonly SpecAdapter[],
  config: SpecsConfig,
): { found: Found[]; unresolved: string[] } {
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
          },
        },
        "section",
      );
    if (section.kind === "spec")
      candidates.push(...sectionReferences(section.text));
  }
  for (const mention of bodyMentions(body))
    if (claimant(adapters, mention) !== null) candidates.push(mention);
  for (const candidate of new Set(candidates)) {
    const checked = checkReference(candidate, root, adapters);
    if (!checked.ok) {
      unresolved.push(`${candidate} (${checked.reason})`);
      continue;
    }
    add(
      {
        adapter: checked.adapter,
        source: {
          adapter: checked.adapter.name,
          ref: checked.ref,
          evidence: [],
        },
        reference: { kind: "file", ref: checked.ref, path: checked.path },
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
  const adapters = await enabledAdapters(registry, config, root);
  const { found, unresolved } = findReferences(
    issueBody(issue),
    root,
    adapters,
    config,
  );
  const read: { source: SpecSource; lists: AdapterRead }[] = [];
  for (const f of found) {
    try {
      read.push({ source: f.source, lists: await f.adapter.read(f.reference) });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      unresolved.push(
        `${f.source.ref} (${f.adapter.name} could not read it: ${why})`,
      );
    }
  }
  return { ...qualify(read), unresolved };
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The result as a few lines for a person: counts, sources, unresolved references. */
export function summary(result: SpecResult): string {
  const lines = [
    `Spec: ${plural(result.sources.length, "source", "sources")}, ${plural(result.requirements.length, "requirement", "requirements")}, ${plural(result.acceptance.length, "acceptance criterion", "acceptance criteria")}, ${plural(result.tasks.length, "task", "tasks")}`,
    ...result.sources.map(
      (s) => `- ${s.ref} (${s.adapter}: ${s.evidence.join(", ")})`,
    ),
  ];
  if (result.unresolved.length > 0)
    lines.push("Unresolved:", ...result.unresolved.map((u) => `- ${u}`));
  return lines.join("\n");
}

const USAGE =
  "usage: resolve.ts [--input <issue.json>] [--root <dir>] [--summary]";

async function main(argv: string[]): Promise<number> {
  let values: { input?: string; root?: string; summary?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        input: { type: "string" },
        root: { type: "string" },
        summary: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (err) {
    fail(2, err instanceof Error ? err.message : String(err), USAGE);
  }
  const issue = await readJsonInput(values.input, readStdinAll);
  if (issue === INVALID_JSON_INPUT) return 2;
  if (!isRecord(issue) || issue.found === false)
    fail(
      2,
      "the input is not an issue: pass the JSON get_issue.ts prints for a found issue",
      USAGE,
    );
  const root = values.root ?? consumerRoot();
  let result: SpecResult;
  try {
    result = await resolveSpec(issue, root);
  } catch (err) {
    fail(1, err instanceof Error ? err.message : String(err));
  }
  console.log(
    values.summary ? summary(result) : JSON.stringify(result, null, 2),
  );
  return 0;
}

if (import.meta.main) runMain("resolve.ts", () => main(process.argv.slice(2)));
