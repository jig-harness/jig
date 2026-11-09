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
 *               message}],
 *     infrastructure: {infrastructure, why, jobs: [{job, infrastructure, why}]} }
 * `job` and `step` name the job and step that printed the line, when the log
 * line carries gh's prefix. `infrastructure` is the shared reading of
 * `shared/ci-infra.ts`: true only when every failed job failed on the
 * infrastructure and printed no code diagnostic.
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
import { readInfrastructure } from "../../../shared/ci-infra.ts";
import { head, parseCiErrors } from "../../../shared/ci-log.ts";
import { runMain } from "../../../shared/cli.ts";
import { detachedTreeRecord } from "../../../shared/driven-tree.ts";
import { gitIdentityEnv, run } from "../../../shared/proc.ts";

export {
  type Category,
  type CiError,
  type ParseResult,
  PRIORITY,
  parseCiErrors,
} from "../../../shared/ci-log.ts";

/** The parsed errors and the infrastructure reading of one log, as printed. */
function reading(log: string, runId: string): string {
  const parsed = parseCiErrors(log, runId);
  return JSON.stringify(
    { ...parsed, infrastructure: readInfrastructure(log) },
    null,
    2,
  );
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How `main` reaches `gh` and `git`; tests replace it. */
export type Runner = (argv: string[]) => Promise<CommandResult>;

/** `gh` lookups get the shared default deadline; a log download gets longer. */
// Git runs without inherited location variables: an exported `GIT_DIR`
// would read another tree's branch and attach record.
export const defaultRunner: Runner = (argv) =>
  run(argv, {
    timeoutSec: argv[1] === "run" && argv[2] === "view" ? 300 : 30,
    ...(argv[0] === "git" ? { env: gitIdentityEnv() } : {}),
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

/**
 * The checked-out branch, or, on a detached tree a drive attached, the branch
 * its record names; '' when neither says.
 */
async function currentBranch(runner: Runner): Promise<string> {
  const r = await runner(["git", "branch", "--show-current"]);
  const branch = r.code === 0 ? r.stdout.trim() : "";
  if (branch !== "") return branch;
  return (await detachedTreeRecord((a) => runner(["git", ...a])))?.branch ?? "";
}

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
    io.out(reading(text, args.runId));
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
      branch = await currentBranch(runner);
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
  io.out(reading(log.stdout, runId));
  return 0;
}

if (import.meta.main)
  runMain("parse-ci-log", () => main(process.argv.slice(2)));
