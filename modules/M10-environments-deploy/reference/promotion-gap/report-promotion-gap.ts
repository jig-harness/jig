#!/usr/bin/env bun
// Promotion gap: which work items have reached one environment but not the
// next, computed from version-control ancestry between the environments'
// pointers.
//
// Every environment is named by a pointer: the `verified` pointer post-merge
// verification advances, the release branch a promotion fast-forwards, the
// commit a deploy pinned. `--from` is the later environment's pointer (the one
// changes are promoted into, `production`) and `--to` the earlier one's (the
// one they are promoted from, `verified`). The commits in `<from>..<to>` are
// those `<to>` holds and `<from>` lacks: the changes waiting for the next
// promotion. The work items those commits name, in their subjects and
// trailers, are the promotion gap. It is never kept by hand in tracker fields:
// a field drifts the moment a promotion is forgotten, while ancestry cannot.
//
// The gap is a range only while the environments sit on one line. When
// `<from>` is not an ancestor of `<to>`, something reached the later
// environment that never went through the earlier one (a hotfix pushed
// straight to the release branch, a pointer moved by hand), so the report
// refuses to decide rather than list a range that hides it.
//
// Input: a pair of refs, read through git in the current directory or
// `--cwd`; or `--log`, the output of
//   git log --format='%H %s%n%(trailers:only,unfold)' <from>..<to>
// collected earlier, so a repository that collects the log in one job and
// reports in another, or a test, needs no git. Each commit is a line of its
// full hash (SHA-1 or SHA-256), a space and its subject, then one line per
// trailer (`Token: value`), then a blank line. A commit listed twice is
// counted once. The keys are what `--pattern` matches
// in that text; the pattern is the repository's own (`[A-Z]+-[0-9]+` for one
// tracker, `#[0-9]+` for another), so it has no default. Looking the keys up
// in the tracker is a seam for whatever consumes the output, not something
// this script does.
//
// Fail closed. No pattern, a pattern that is not a regular expression or that
// can match an empty string, a ref that does not name a commit, a `<from>`
// that is not an ancestor of `<to>`, a git call that fails, a log that is
// empty (what a failed collection leaves behind), holds a line that is neither
// a commit line nor a trailer, or lists one commit twice with different
// content, or a bad option exits 2. An empty
// range from two resolved refs is a gap of nothing, exit 0.
//
// Exit codes: 0 the gap is reported (and within `--max-items`, when given),
// 1 the gap holds more work items than `--max-items`, 2 usage or input error.
//
// Usage:
//   report-promotion-gap.ts --pattern <regex> (--from <ref> --to <ref> [--cwd <dir>] | --log <file|->)
//                           [--ignore-case] [--max-items <n>] [--json]
// Every option is long-form and strict: an unknown one, or one missing its
// value, is a usage error.
import { readFileSync } from "node:fs";
import { cli, strictOptions } from "../../../../lib/cli.ts";

export interface Commit {
  sha: string;
  subject: string;
  trailers: string[];
}

export interface Item {
  key: string;
  commits: string[];
}

export interface Gap {
  commits: number;
  items: Item[];
  unkeyed: { sha: string; subject: string }[];
}

const usage =
  "usage: report-promotion-gap.ts --pattern <regex> (--from <ref> --to <ref> [--cwd <dir>] | --log <file|->) [--ignore-case] [--max-items <n>] [--json]";

export const LOG_FORMAT = "%H %s%n%(trailers:only,unfold)";

const RECORD = /^([0-9a-f]{40}|[0-9a-f]{64}) (.*)$/;
const TRAILER = /^[A-Za-z0-9][A-Za-z0-9_-]*:\s/;

/**
 * The commits of a collected log, each once; throw on an empty log, a line of
 * another shape, or one commit listed twice with different content.
 */
export function parseLog(text: string): Commit[] {
  if (text.trim() === "")
    throw new Error(
      "the log is empty: a failed collection leaves an empty file, so an empty range must come from --from and --to",
    );
  const commits: Commit[] = [];
  let current: Commit | undefined;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const record = RECORD.exec(line);
    if (record !== null) {
      current = {
        sha: record[1] ?? "",
        subject: record[2] ?? "",
        trailers: [],
      };
      commits.push(current);
    } else if (line !== "") {
      if (current === undefined || !TRAILER.test(line))
        throw new Error(
          `log line ${index + 1} is neither a commit line (<hash> <subject>) nor a trailer (Token: value): ${line}`,
        );
      current.trailers.push(line);
    }
  }
  return distinct(commits);
}

/** The commits with repeats dropped; throw when two copies of one commit differ. */
function distinct(commits: Commit[]): Commit[] {
  const seen = new Map<string, string>();
  const kept: Commit[] = [];
  for (const commit of commits) {
    const content = JSON.stringify([commit.subject, commit.trailers]);
    const earlier = seen.get(commit.sha);
    if (earlier === undefined) {
      seen.set(commit.sha, content);
      kept.push(commit);
    } else if (earlier !== content)
      throw new Error(
        `commit ${commit.sha} is listed twice with different subjects or trailers, so the log is not one collection`,
      );
  }
  return kept;
}

/** The key pattern as a global regular expression; throw unless it can match something. */
export function compilePattern(source: string, ignoreCase: boolean): RegExp {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, ignoreCase ? "gi" : "g");
  } catch {
    throw new Error(`--pattern is not a regular expression: ${source}`);
  }
  if (pattern.test("")) {
    throw new Error(
      `--pattern matches the empty string, so every commit would name a key: ${source}`,
    );
  }
  pattern.lastIndex = 0;
  return pattern;
}

/**
 * The distinct keys the pattern finds in a text, in order of first appearance;
 * throw on an empty match, which a pattern such as `\b` or a lookahead makes
 * even though it never matches the empty text.
 */
export function keysIn(
  text: string,
  pattern: RegExp,
  ignoreCase: boolean,
): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    if (match[0] === "")
      throw new Error(
        `--pattern matched an empty string at offset ${match.index} of "${text.split("\n")[0]}": a key must be text`,
      );
    keys.add(ignoreCase ? match[0].toUpperCase() : match[0]);
  }
  return [...keys];
}

/** The work items the commits name, each with its commits, and the commits that name none. */
export function promotionGap(
  commits: Commit[],
  pattern: RegExp,
  ignoreCase: boolean,
): Gap {
  const byKey = new Map<string, string[]>();
  const unkeyed: Gap["unkeyed"] = [];
  for (const commit of commits) {
    const keys = keysIn(
      [commit.subject, ...commit.trailers].join("\n"),
      pattern,
      ignoreCase,
    );
    if (keys.length === 0)
      unkeyed.push({ sha: commit.sha, subject: commit.subject });
    for (const key of keys) {
      const list = byKey.get(key) ?? [];
      list.push(commit.sha);
      byKey.set(key, list);
    }
  }
  const items = [...byKey]
    .map(([key, shas]) => ({ key, commits: shas }))
    .sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return { commits: commits.length, items, unkeyed };
}

export interface Options {
  pattern: string;
  from: string | undefined;
  to: string | undefined;
  cwd: string;
  log: string | undefined;
  ignoreCase: boolean;
  maxItems: number | undefined;
  json: boolean;
}

const OPTIONS = {
  pattern: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  cwd: { type: "string" },
  log: { type: "string" },
  "ignore-case": { type: "boolean" },
  "max-items": { type: "string" },
  json: { type: "boolean" },
} as const;

/** The options, with the mode rules checked; throw with the usage on any other shape. */
export function parseOptions(args: string[]): Options {
  const { values } = strictOptions(
    { args, options: OPTIONS, allowPositionals: false },
    usage,
  );
  if (values.pattern === undefined)
    throw new Error(`--pattern is required\n${usage}`);
  const refs = values.from !== undefined || values.to !== undefined;
  if (refs && values.log !== undefined)
    throw new Error(`--log excludes --from and --to\n${usage}`);
  if (refs && (values.from === undefined || values.to === undefined))
    throw new Error(`--from and --to go together\n${usage}`);
  if (!refs && values.log === undefined)
    throw new Error(`give --from and --to, or --log\n${usage}`);
  return {
    pattern: values.pattern,
    from: values.from,
    to: values.to,
    cwd: values.cwd ?? process.cwd(),
    log: values.log,
    ignoreCase: values["ignore-case"] === true,
    maxItems:
      values["max-items"] === undefined
        ? undefined
        : parseBound(values["max-items"]),
    json: values.json === true,
  };
}

function parseBound(value: string): number {
  if (!/^[0-9]{1,9}$/.test(value))
    throw new Error(
      `--max-items must be a non-negative integer: ${value}\n${usage}`,
    );
  return Number(value);
}

/**
 * The variables that send git to a repository other than the one `cwd` holds.
 * A git hook exports the first ones pointing at its own repository, so a report
 * launched from a hook would otherwise read that repository whatever `--cwd`
 * says; `GIT_NAMESPACE` would scope the refs it resolves.
 */
const ROUTING_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
]);

/** The environment with the repository-routing variables removed. */
function gitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !ROUTING_GIT_ENV.has(key.toUpperCase()))
      clean[key] = value;
  return clean;
}

function git(cwd: string, args: string[]) {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitEnv(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    err: run.stderr.toString().trim(),
  };
}

/** The commit a ref names; throw when it names none. */
function resolveRef(cwd: string, ref: string): string {
  const run = git(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (run.code !== 0)
    throw new Error(
      `${ref} does not name a commit${run.err === "" ? "" : `: ${run.err}`}`,
    );
  return run.out.trim();
}

interface Resolved {
  from: { ref: string; sha: string };
  to: { ref: string; sha: string };
}

/** The collected log of `from..to`, once both refs resolve and `from` is an ancestor of `to`. */
function collect(cwd: string, fromRef: string, toRef: string) {
  const from = { ref: fromRef, sha: resolveRef(cwd, fromRef) };
  const to = { ref: toRef, sha: resolveRef(cwd, toRef) };
  const ancestry = git(cwd, ["merge-base", "--is-ancestor", from.sha, to.sha]);
  if (ancestry.code === 1)
    throw new Error(
      `${fromRef} is not an ancestor of ${toRef}: the environments are not on one line, so the gap is not a range (something reached ${fromRef} that never went through ${toRef}; see the module's divergence rule)`,
    );
  if (ancestry.code !== 0)
    throw new Error(`git merge-base failed: ${ancestry.err}`);
  const log = git(cwd, [
    "log",
    `--format=${LOG_FORMAT}`,
    "--end-of-options",
    `${from.sha}..${to.sha}`,
  ]);
  if (log.code !== 0) throw new Error(`git log failed: ${log.err}`);
  const resolved: Resolved = { from, to };
  return { resolved, log: log.out };
}

function readLog(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function render(
  gap: Gap,
  resolved: Resolved | null,
  maxItems: number | undefined,
): string {
  const over = maxItems !== undefined && gap.items.length > maxItems;
  const range =
    resolved === null
      ? "the collected log"
      : `${resolved.from.ref}..${resolved.to.ref}`;
  const head = over
    ? `OVER — ${gap.items.length} work item(s) wait in ${range}, more than ${maxItems}`
    : `GAP — ${gap.items.length} work item(s) across ${gap.commits} commit(s) in ${range}`;
  const lines = [
    `${head}; ${gap.unkeyed.length} commit(s) name no item`,
    ...gap.items.map(
      (item) => `  - ${item.key} (${item.commits.length} commit(s))`,
    ),
    ...gap.unkeyed.map(
      (commit) => `  - (no item) ${commit.sha.slice(0, 12)} ${commit.subject}`,
    ),
  ];
  return lines.join("\n");
}

/** The commits to report on, from the log file or from git, with the refs when git was read. */
function commitsFor(options: Options): {
  resolved: Resolved | null;
  commits: Commit[];
} {
  if (options.log !== undefined)
    return { resolved: null, commits: parseLog(readLog(options.log)) };
  const { resolved, log } = collect(
    options.cwd,
    options.from ?? "",
    options.to ?? "",
  );
  // Two resolved refs with nothing between them are a gap of nothing.
  return { resolved, commits: log === "" ? [] : parseLog(log) };
}

function asJson(
  gap: Gap,
  resolved: Resolved | null,
  options: Options,
  over: boolean,
) {
  return JSON.stringify(
    {
      from: resolved?.from ?? null,
      to: resolved?.to ?? null,
      commits: gap.commits,
      items: gap.items,
      unkeyed: gap.unkeyed,
      maxItems: options.maxItems ?? null,
      over,
    },
    null,
    2,
  );
}

export function main(args = process.argv.slice(2)): number {
  const options = parseOptions(args);
  const pattern = compilePattern(options.pattern, options.ignoreCase);
  const { resolved, commits } = commitsFor(options);
  const gap = promotionGap(commits, pattern, options.ignoreCase);
  const over =
    options.maxItems !== undefined && gap.items.length > options.maxItems;
  console.log(
    options.json
      ? asJson(gap, resolved, options, over)
      : render(gap, resolved, options.maxItems),
  );
  return over ? 1 : 0;
}

if (import.meta.main) cli(() => main());
