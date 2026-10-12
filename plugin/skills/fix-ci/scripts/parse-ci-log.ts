#!/usr/bin/env bun
/**
 * Fetch a failed GitHub Actions run's log and sort its errors into
 * categories, in the order they should be fixed.
 *
 * Usage (from inside the repository whose CI failed):
 *   bun parse-ci-log.ts                  latest failed run on the current branch
 *   bun parse-ci-log.ts <run_id>         that run
 *   bun parse-ci-log.ts --pr <number>    latest failed run on the PR's branch
 *   bun parse-ci-log.ts '#<number>'      the same, PR written as #<number>
 *   bun parse-ci-log.ts --branch <name>  latest failed run on that branch
 *   bun parse-ci-log.ts --log <file> [run_id]
 *                                        parse a saved log instead of fetching
 *
 * Prints one JSON object on stdout:
 *   { run_id, errors_found, summary: {category: count}, files_affected,
 *     errors: [{category, job?, step?, raw, file?, line?, column?, code?, rule?,
 *               message}] }
 * `job` and `step` name the job and step that printed the line, when the log
 * line carries gh's prefix.
 * or, when there is nothing to parse, { error, errors_found: 0, errors: [] }
 * with `error` set to `no_failed_runs` (gh listed no failed run) or
 * `PR #<n> not found` (gh reported no such pull request).
 *
 * Exit codes: 0 parsed (or nothing to parse, see `error`); 1 a lookup or the
 * log could not be fetched or read, or gh answered with something unreadable;
 * 2 usage error.
 *
 * `gh` and `git` are reached only through the `Runner` passed to `main`, so
 * tests feed saved log text without a network or a repository.
 */

import { readFileSync } from "node:fs";
import { runMain } from "../../resolve-review-comments/scripts/lib/cli.ts";
import { run } from "../../resolve-review-comments/scripts/lib/proc.ts";

export type Category =
  | "schema_drift"
  | "build_error"
  | "drift_check"
  | "typescript"
  | "biome_lint"
  | "test_failure"
  | "gate_failure"
  | "process_exit";

export interface CiError {
  category: Category;
  /** The job that printed the line, from gh's log prefix. */
  job?: string;
  /** The step that printed the line, from gh's log prefix. */
  step?: string;
  raw: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  rule?: string;
  message?: string;
}

export interface ParseResult {
  run_id: string;
  errors_found: number;
  summary: Partial<Record<Category, number>>;
  files_affected: string[];
  errors: CiError[];
}

/** Fix order: a stale schema or a missing module causes errors further down. */
export const PRIORITY: Record<Category, number> = {
  schema_drift: 0,
  build_error: 1,
  drift_check: 2,
  typescript: 3,
  biome_lint: 4,
  test_failure: 5,
  gate_failure: 6,
  process_exit: 7,
};

/**
 * Line patterns, tried in order; the first that matches a line claims it.
 * The `s` flag lets `.` match any character except the line break the log is
 * split on, and `u` gives case-insensitive matching Unicode case folding.
 */
const PATTERNS: [RegExp, Category][] = [
  // TypeScript compiler: file(line,col): error TSxxxx: message
  [/(\S+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)/su, "typescript"],
  // Biome lint: path/file.ts lint/category/rule  message
  [/(\S+\.tsx?)\s+(lint\/\S+)\s+(.+)/su, "biome_lint"],
  // Biome diagnostic with a cross marker. The two characters before `error`
  // are the cross (U+00D7) as it reads when its UTF-8 bytes were decoded as
  // Latin-1, the form it takes in some captured logs.
  [/(\S+\.tsx?):(\d+):(\d+)\s+.*(?:\xc3\x97|error)\s+(.+)/su, "biome_lint"],
  // Test runner: FAIL path/to/file.spec.ts
  [/FAIL\s+(\S+\.(?:spec|test)\.tsx?)/su, "test_failure"],
  // Test assertion: file > suite > ... > test, split on the `>` delimiters in
  // `entryFor` so the message keeps the whole path.
  [/(\S+\.(?:spec|test)\.tsx?)\s+>\s+(.+)/su, "test_failure"],
  [/Cannot find module '([^']+)'/su, "build_error"],
  [/Module not found/su, "build_error"],
  // Database schema drift (an ORM schema or a schema dump checked against
  // migrations).
  [/schema.drift|Schema drift detected|schema:check.*fail/su, "schema_drift"],
  // Generated-artifact drift checks: API specs, type surfaces, error-code
  // registries, generated API clients. Usually fixed by a generate or sync
  // script.
  [
    /(drift detected|out[- ]of[- ]sync|OpenAPI (spec )?drift|type[- ]surface drift|error[- ]code drift|Eden coverage|regenerate the (schema|spec|types|SDK|Eden|OpenAPI)|run [`']?(?:pnpm|npm run|yarn|bun run) [\p{L}\p{N}_:-]+:(generate|sync))/isu,
    "drift_check",
  ],
  // The runner's own note that a step exited nonzero. It accompanies a failed
  // gate and an infrastructure failure (a timeout, a lost runner) alike, so it
  // gets its own category rather than counting as a gate diagnostic.
  [/^##\[error\]Process completed with exit code \d+\.?$/su, "process_exit"],
  // Any other failed check that reports an error annotation (a grep gate, a
  // ratchet, a self-test). Without it such a run would count zero errors and
  // read as a flaky runner. Kept last so a specific category wins.
  [/^\s*(::error|##\[error\]|❌|✗|(?:error|failed):)/isu, "gate_failure"],
];

/**
 * `gh run view --log-failed` prefixes every line with
 * `<job>\t<step>\t<ISO-timestamp> `; stripping it lets anchored patterns and
 * the captured `raw` text work on the real content.
 */
const LOG_PREFIX = /^.*?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/su;

/** The job and step named in a stripped prefix, when it has both fields. */
function provenance(prefix: string): { job?: string; step?: string } {
  const fields = prefix.split("\t");
  if (fields.length < 3) return {};
  return { job: fields[0] as string, step: fields[1] as string };
}

/** The first `n` characters, counted in code points rather than UTF-16 units. */
function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

/** Code-point order, so sorting agrees for characters outside the BMP. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function entryFor(
  category: Category,
  origin: { job?: string; step?: string },
  line: string,
  groups: (string | undefined)[],
): CiError {
  const entry: CiError = { category, ...origin, raw: head(line, 200) };
  const g = (i: number) => groups[i] ?? "";
  switch (category) {
    case "typescript":
      entry.file = g(0);
      entry.line = Number.parseInt(g(1), 10);
      entry.column = Number.parseInt(g(2), 10);
      entry.code = g(3);
      entry.message = g(4).trim();
      break;
    case "biome_lint":
      entry.file = g(0);
      entry.rule = g(1).includes("/") ? g(1) : "";
      entry.message = g(groups.length - 1).trim();
      break;
    case "test_failure":
      entry.file = g(0);
      entry.message =
        groups.length > 1
          ? g(1)
              .split(/\s+>\s+/u)
              .map((part) => part.trim())
              .join(" > ")
          : "";
      break;
    case "schema_drift":
      entry.message =
        "Schema drift detected - regenerate the schema (fix_ci.regenerate_commands)";
      break;
    default:
      // build_error, drift_check, gate_failure, process_exit: the line itself
      // says it best.
      entry.message = head(line, 200);
  }
  return entry;
}

/** Categorize every error line in a failed run's log. */
export function parseCiErrors(logContent: string, runId = ""): ParseResult {
  const errors: CiError[] = [];
  const seen = new Set<string>();
  for (const rawLine of logContent.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    const origin = provenance(LOG_PREFIX.exec(trimmed)?.[0] ?? "");
    const line = trimmed.replace(LOG_PREFIX, "").trim();
    if (line === "") continue;
    for (const [pattern, category] of PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const entry = entryFor(category, origin, line, match.slice(1));
      // The whole line, not the possibly truncated or constant `message`, and
      // the step that printed it, so only a repeat of the same diagnostic from
      // the same step collapses: two steps' identical exit notes stay apart.
      const key = JSON.stringify([
        entry.category,
        entry.job ?? null,
        entry.step ?? null,
        entry.file ?? null,
        entry.line ?? null,
        entry.column ?? null,
        entry.code ?? null,
        entry.rule ?? null,
        line,
      ]);
      if (!seen.has(key)) {
        seen.add(key);
        errors.push(entry);
      }
      break;
    }
  }
  errors.sort((a, b) => PRIORITY[a.category] - PRIORITY[b.category]);
  const summary: Partial<Record<Category, number>> = {};
  for (const e of errors) summary[e.category] = (summary[e.category] ?? 0) + 1;
  const files = [
    ...new Set(errors.map((e) => e.file ?? "").filter((f) => f !== "")),
  ].sort(byCodePoint);
  return {
    run_id: runId,
    errors_found: errors.length,
    summary,
    files_affected: files,
    errors,
  };
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How `main` reaches `gh` and `git`; tests replace it. */
export type Runner = (argv: string[]) => Promise<CommandResult>;

/** `gh` lookups get the shared default deadline; a log download gets longer. */
export const defaultRunner: Runner = (argv) =>
  run(argv, {
    timeoutSec: argv[1] === "run" && argv[2] === "view" ? 300 : 30,
  });

export interface Args {
  runId: string;
  pr: string;
  branch: string;
  logFile: string;
}

const USAGE =
  "usage: parse-ci-log.ts [run_id | #<pr>] [--pr <number>] [--branch <name>] [--log <file>]";

/** Parse the command line; returns a usage message on error. */
export function parseArgs(argv: string[]): Args | string {
  const args: Args = { runId: "", pr: "", branch: "", logFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (): string | undefined => {
      const v = argv[i + 1];
      i++;
      return v === undefined || v === "" ? undefined : v;
    };
    if (a === "--pr" || a === "--branch" || a === "--log") {
      const v = value();
      if (v === undefined) return `${a} requires a value\n${USAGE}`;
      if (a === "--pr") args.pr = v.replace(/^#/, "");
      else if (a === "--branch") args.branch = v;
      else args.logFile = v;
    } else if (a === "-h" || a === "--help") {
      return USAGE;
    } else if (a.startsWith("--")) {
      return `unknown flag: ${a}\n${USAGE}`;
    } else if (/^#\d+$/.test(a)) {
      args.pr = a.slice(1);
    } else if (/^\d+$/.test(a)) {
      args.runId = a;
    } else {
      args.branch = a;
    }
  }
  if (args.pr !== "" && !/^\d+$/.test(args.pr))
    return `--pr takes a pull request number, got '${args.pr}'\n${USAGE}`;
  return args;
}

function nothingToParse(error: string): string {
  return JSON.stringify({ error, errors_found: 0, errors: [] });
}

/**
 * The latest failed run on a branch: its ID, "" when gh listed none, or an
 * `{ error }` when gh failed or answered with something other than a run list.
 */
async function latestFailedRun(
  runner: Runner,
  branch: string,
): Promise<string | { error: string }> {
  const r = await runner([
    "gh",
    "run",
    "list",
    "--branch",
    branch,
    "--status",
    "failure",
    "--limit",
    "1",
    "--json",
    "databaseId",
  ]);
  const what = `gh run list --branch ${branch}`;
  if (r.code !== 0)
    return { error: `${what} exited ${r.code}: ${r.stderr.trim()}` };
  let runs: unknown;
  try {
    runs = JSON.parse(r.stdout);
  } catch {
    return { error: `${what} printed malformed JSON: ${head(r.stdout, 200)}` };
  }
  if (!Array.isArray(runs))
    return { error: `${what} printed no run list: ${head(r.stdout, 200)}` };
  if (runs.length === 0) return "";
  const id = (runs[0] as { databaseId?: unknown } | null)?.databaseId;
  if (typeof id !== "number" || !Number.isInteger(id))
    return { error: `${what} printed a run without a databaseId` };
  return String(id);
}

/** gh's answer when the pull request does not exist. */
const PR_NOT_FOUND =
  /Could not resolve to a PullRequest|no pull requests found/iu;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  readFile: (path: string) => string;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  readFile: (path) => readFileSync(path, "utf8"),
};

export async function main(
  argv: string[],
  runner: Runner = defaultRunner,
  io: Io = defaultIo,
): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(args);
    return args === USAGE ? 0 : 2;
  }

  if (args.logFile !== "") {
    let text: string;
    try {
      text = io.readFile(args.logFile);
    } catch (e) {
      io.err(
        `parse-ci-log: cannot read ${args.logFile}: ${e instanceof Error ? e.message : e}`,
      );
      return 1;
    }
    io.out(JSON.stringify(parseCiErrors(text, args.runId), null, 2));
    return 0;
  }

  let runId = args.runId;
  if (runId === "") {
    let branch = args.branch;
    if (args.pr !== "") {
      const r = await runner([
        "gh",
        "pr",
        "view",
        args.pr,
        "--json",
        "headRefName",
        "-q",
        ".headRefName",
      ]);
      if (r.code !== 0 && PR_NOT_FOUND.test(r.stderr)) {
        io.out(nothingToParse(`PR #${args.pr} not found`));
        return 0;
      }
      branch = r.code === 0 ? r.stdout.trim() : "";
      if (branch === "") {
        io.err(
          `parse-ci-log: gh pr view ${args.pr} exited ${r.code} without a branch: ${r.stderr.trim()}`,
        );
        return 1;
      }
    } else if (branch === "") {
      const r = await runner(["git", "branch", "--show-current"]);
      branch = r.code === 0 ? r.stdout.trim() : "";
      if (branch === "") {
        io.err(
          "parse-ci-log: no current branch (detached HEAD?); pass a run ID, --pr or --branch",
        );
        return 2;
      }
    }
    const latest = await latestFailedRun(runner, branch);
    if (typeof latest !== "string") {
      io.err(`parse-ci-log: ${latest.error}`);
      return 1;
    }
    runId = latest;
  }
  if (runId === "") {
    io.out(nothingToParse("no_failed_runs"));
    return 0;
  }

  const log = await runner(["gh", "run", "view", runId, "--log-failed"]);
  if (log.code !== 0) {
    io.err(
      `parse-ci-log: gh run view ${runId} --log-failed exited ${log.code}: ${log.stderr.trim()}`,
    );
    return 1;
  }
  io.out(JSON.stringify(parseCiErrors(log.stdout, runId), null, 2));
  return 0;
}

if (import.meta.main)
  runMain("parse-ci-log", () => main(process.argv.slice(2)));
