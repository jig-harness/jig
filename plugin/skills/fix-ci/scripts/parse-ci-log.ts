#!/usr/bin/env bun
/**
 * Fetch a failed GitHub Actions run's log and sort its errors into
 * categories, in the order they should be fixed.
 *
 * Usage (from inside the repository whose CI failed):
 *   bun parse-ci-log.ts                  latest failed run on the current branch
 *   bun parse-ci-log.ts <run_id>         that run
 *   bun parse-ci-log.ts --pr <number>    latest failed run on the PR's branch,
 *                                        and the failing commit statuses on
 *                                        its head (logs via ci.log_command)
 *   bun parse-ci-log.ts '#<number>'      the same, PR written as #<number>
 *   bun parse-ci-log.ts --branch <name>  latest failed run on that branch
 *   bun parse-ci-log.ts --log <file> [run_id]
 *                                        parse a saved log instead of fetching
 *
 * Prints one JSON object on stdout:
 *   { run_id, errors_found, summary: {category: count}, files_affected,
 *     errors: [{category, job?, step?, raw, file?, line?, column?, code?, rule?,
 *               message}],
 *     run_errors_found?, infrastructure: {infrastructure, why, jobs: [{job, infrastructure, why}]},
 *     statuses?: [{context, target_url, log, reason?, log_tail?}] }
 * `job` and `step` name the job and step that printed the line, when the log
 * line carries gh's prefix; an error from a commit status's log names the
 * status's context as its `job`. `infrastructure` is the shared reading of
 * `shared/ci-infra.ts` over the Actions run's log: true only when every
 * failed job failed on the infrastructure and printed no code diagnostic, and
 * never when a commit status also failed. `run_errors_found`, present with
 * `statuses`, counts the errors parsed from the Actions run's own log alone. A status log read with no known
 * diagnostic carries its last characters as `log_tail`.
 * With a pull request, `statuses` lists each failing commit status on its
 * head, `log` being `read`, `gone` (`ci.log_command` exited 3; `reason` is
 * the first line it printed) or `unread` (no `ci.log_command` is set).
 * When there is nothing to parse it prints { error, errors_found: 0, errors: [] }
 * with `error` set to `no_failed_runs` (gh listed no failed run, and the pull
 * request's head has no failing status) or `PR #<n> not found` (gh reported
 * no such pull request).
 *
 * Exit codes: 0 parsed (or nothing to parse, see `error`); 1 a lookup or a
 * log could not be fetched or read (`ci.log_command` failing or running past
 * its deadline, or the default branch that sets it unreadable, included), or
 * gh answered with something unreadable; 2 usage error, or an invalid
 * `ci.log_command` or `JIG_FIX_CI_LOG_COMMAND_TIMEOUT_SEC`.
 *
 * `gh` and `git` are reached only through the `Runner` passed to `main`, and
 * `ci.log_command` only through its `StatusLogs`, so tests feed saved log
 * text without a network or a repository.
 */

import { readFileSync } from "node:fs";
import {
  type InfraReading,
  readInfrastructure,
} from "../../../shared/ci-infra.ts";
import {
  head,
  parseCiErrors,
  summarizeCiErrors,
} from "../../../shared/ci-log.ts";
import {
  ciRepairSettings,
  combinedStatuses,
  type FailingStatus,
  failingStatus,
  isFailingStatus,
} from "../../../shared/ci-status.ts";
import { runMain } from "../../../shared/cli.ts";
import { detachedTreeRecord } from "../../../shared/driven-tree.ts";
import { attempt, type Outcome, ok } from "../../../shared/outcome.ts";
import { gitIdentityEnv, run } from "../../../shared/proc.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import {
  logCommandOf,
  logCommandSeconds,
  readStatusLog,
  type StatusLog,
} from "./status-log.ts";

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

/** One failing commit status as printed, with what became of its log. */
export interface StatusEntry extends FailingStatus {
  log: "read" | "gone" | "unread";
  reason?: string;
  /**
   * The end of a log that was read but held no diagnostic the parser knows,
   * so the failure is not lost with the parse.
   */
  log_tail?: string;
}

/** Characters of an unparsed status log kept as its `log_tail`. */
const LOG_TAIL_CHARS = 4000;

/** A failing status's entry, with its log when the command printed one. */
interface StatusReading {
  entry: StatusEntry;
  log: string | null;
}

/**
 * The Actions run's log (when one failed) and the failing statuses' logs as
 * one reading. The infrastructure reading is the run's alone: a status's log
 * is the CI service's own form, which the shared rule does not read.
 */
function combinedReading(
  runLog: string | null,
  runId: string,
  statuses: readonly StatusReading[],
): string {
  const entries: StatusEntry[] = [];
  const statusErrors = statuses.flatMap(({ entry, log }) => {
    if (log === null) {
      entries.push(entry);
      return [];
    }
    const parsed = parseCiErrors(log).errors;
    entries.push(
      parsed.length > 0
        ? entry
        : {
            ...entry,
            log_tail: Array.from(log).slice(-LOG_TAIL_CHARS).join(""),
          },
    );
    return parsed.map((e) => ({ ...e, job: e.job ?? entry.context }));
  });
  const runErrors = runLog === null ? [] : parseCiErrors(runLog, runId).errors;
  const errors = [...runErrors, ...statusErrors];
  const actions: InfraReading | null =
    runLog === null ? null : readInfrastructure(runLog);
  // Infrastructure only when every failure source is the Actions run: a
  // commit status's log is the CI service's own form, which the shared rule
  // cannot read, so any failing status keeps the verdict at "not
  // infrastructure" and the repair on the code.
  const infrastructure: InfraReading =
    statuses.length > 0
      ? {
          infrastructure: false,
          why: "a failing commit status is present; its log is not read for infrastructure",
          jobs: actions?.jobs ?? [],
        }
      : (actions as InfraReading);
  return JSON.stringify(
    {
      ...summarizeCiErrors(errors, runId),
      run_errors_found: runErrors.length,
      infrastructure,
      statuses: entries,
    },
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

/** `ci.log_command`, the deadline each of its runs gets, and where it runs. */
export interface LogCommand {
  command: string;
  seconds: number;
  root: string;
}

/** How `main` reaches `ci.log_command`; tests replace it. */
export interface StatusLogs {
  /**
   * The command, `null` when none is set; an `invalid-config` failure when
   * it or its deadline is invalid, an `unreadable` one when the default
   * branch that sets it cannot be read.
   */
  settings(): Promise<Outcome<LogCommand | null>>;
  /** One failing status's log, or why the command could not give one. */
  read(command: LogCommand, status: FailingStatus): Promise<Outcome<StatusLog>>;
}

export const defaultStatusLogs: StatusLogs = {
  async settings() {
    // The working tree's file says only whether a command is set at all:
    // the one that runs is the default branch's.
    const config = attempt("invalid-config", "the configuration", () =>
      ciRepairSettings(),
    );
    if (!config.ok) return config;
    if (!config.value.ok) return config.value;
    const root = consumerRoot();
    const command = await logCommandOf(root, config.value.value.logCommand);
    if (!command.ok) return command;
    if (command.value === null) return ok(null);
    const seconds = logCommandSeconds();
    return seconds.ok
      ? ok({ command: command.value, seconds: seconds.value, root })
      : seconds;
  },
  read: ({ command, seconds, root }, status) =>
    readStatusLog(command, status, seconds, root),
};

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

/** A pull request's head branch and commit, or why they could not be read. */
async function pullRequestHead(
  runner: Runner,
  pr: string,
): Promise<{ branch: string; sha: string } | "not-found" | { error: string }> {
  const r = await runner([
    "gh",
    "pr",
    "view",
    pr,
    "--json",
    "headRefName,headRefOid",
  ]);
  if (r.code !== 0 && PR_NOT_FOUND.test(r.stderr)) return "not-found";
  let view: unknown = null;
  try {
    view = r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    view = null;
  }
  const { headRefName: branch, headRefOid: sha } = (view ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof branch !== "string" || branch === "" || typeof sha !== "string")
    return {
      error: `gh pr view ${pr} exited ${r.code} without a branch: ${r.stderr.trim() || head(r.stdout, 200)}`,
    };
  return { branch, sha };
}

/** The failing commit statuses on `sha`, an aborted build left out. */
async function failingStatusesOn(
  runner: Runner,
  sha: string,
): Promise<FailingStatus[] | { error: string }> {
  const path = `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`;
  const r = await runner(["gh", "api", "--paginate", "--slurp", path]);
  if (r.code !== 0)
    return { error: `gh api ${path} exited ${r.code}: ${r.stderr.trim()}` };
  const statuses = combinedStatuses(r.stdout);
  if (statuses === null)
    return { error: `gh api ${path} printed malformed JSON` };
  return statuses.filter(isFailingStatus).map(failingStatus);
}

/** Each status's log through `ci.log_command`; a failure stops the reading. */
async function readStatuses(
  statuses: readonly FailingStatus[],
  command: LogCommand | null,
  logs: StatusLogs,
): Promise<Outcome<StatusReading[]>> {
  const read: StatusReading[] = [];
  for (const status of statuses) {
    if (command === null) {
      read.push({
        entry: {
          ...status,
          log: "unread",
          reason: "ci.log_command is not set",
        },
        log: null,
      });
      continue;
    }
    const answer = await logs.read(command, status);
    if (!answer.ok) return answer;
    read.push(
      answer.value.kind === "log"
        ? { entry: { ...status, log: "read" }, log: answer.value.text }
        : {
            entry: { ...status, log: "gone", reason: answer.value.reason },
            log: null,
          },
    );
  }
  return ok(read);
}

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

/**
 * A pull request's failing statuses, each with its log; the exit code, its
 * reason printed, when they could not be read.
 */
async function pullRequestStatuses(
  runner: Runner,
  logs: StatusLogs,
  io: Io,
  sha: string,
): Promise<StatusReading[] | number> {
  const command = await logs.settings();
  if (!command.ok) {
    io.err(`parse-ci-log: ${command.failure.reason}`);
    return command.failure.code === "invalid-config" ? 2 : 1;
  }
  const failing = await failingStatusesOn(runner, sha);
  if (!Array.isArray(failing)) {
    io.err(`parse-ci-log: ${failing.error}`);
    return 1;
  }
  const read = await readStatuses(failing, command.value, logs);
  if (!read.ok) {
    io.err(`parse-ci-log: ${read.failure.reason}`);
    return 1;
  }
  return read.value;
}

/** What to read: the failed run (`""` for none), and a pull request's statuses. */
interface Failure {
  runId: string;
  /** Read only for a pull request: its head names the commit whose statuses count. */
  statuses: StatusReading[] | null;
}

/**
 * The branch whose latest failed run to read and, for a pull request, its
 * failing statuses; an exit code, its reason printed, when there is none.
 */
async function branchToRead(
  args: Args,
  runner: Runner,
  io: Io,
  logs: StatusLogs,
): Promise<{ branch: string; statuses: StatusReading[] | null } | number> {
  if (args.pr !== "") {
    const pr = await pullRequestHead(runner, args.pr);
    if (pr === "not-found") {
      io.out(nothingToParse(`PR #${args.pr} not found`));
      return 0;
    }
    if ("error" in pr) {
      io.err(`parse-ci-log: ${pr.error}`);
      return 1;
    }
    const read = await pullRequestStatuses(runner, logs, io, pr.sha);
    return typeof read === "number"
      ? read
      : { branch: pr.branch, statuses: read };
  }
  const branch = args.branch || (await currentBranch(runner));
  if (branch !== "") return { branch, statuses: null };
  io.err(
    "parse-ci-log: no current branch (detached HEAD?); pass a run ID, --pr or --branch",
  );
  return 2;
}

/** The run named, or the latest failed one, with the statuses beside it. */
async function failureToRead(
  args: Args,
  runner: Runner,
  io: Io,
  logs: StatusLogs,
): Promise<Failure | number> {
  if (args.runId !== "") return { runId: args.runId, statuses: null };
  const target = await branchToRead(args, runner, io, logs);
  if (typeof target === "number") return target;
  const latest = await latestFailedRun(runner, target.branch);
  if (typeof latest === "string")
    return { runId: latest, statuses: target.statuses };
  io.err(`parse-ci-log: ${latest.error}`);
  return 1;
}

/** A failed run's log; `null`, its reason printed, when gh cannot give it. */
async function runLogOf(
  runner: Runner,
  io: Io,
  runId: string,
): Promise<string | null> {
  const log = await runner(["gh", "run", "view", runId, "--log-failed"]);
  if (log.code === 0) return log.stdout;
  io.err(
    `parse-ci-log: gh run view ${runId} --log-failed exited ${log.code}: ${log.stderr.trim()}`,
  );
  return null;
}

/** A saved log, parsed; `--log` reads no forge. */
function savedLog(args: Args, io: Io): number {
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

export async function main(
  argv: string[],
  runner: Runner = defaultRunner,
  io: Io = defaultIo,
  logs: StatusLogs = defaultStatusLogs,
): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(args);
    return args === USAGE ? 0 : 2;
  }
  if (args.logFile !== "") return savedLog(args, io);

  const failure = await failureToRead(args, runner, io, logs);
  if (typeof failure === "number") return failure;
  const { runId, statuses } = failure;
  if (runId === "" && (statuses ?? []).length === 0) {
    io.out(nothingToParse("no_failed_runs"));
    return 0;
  }
  const runLog = runId === "" ? null : await runLogOf(runner, io, runId);
  if (runId !== "" && runLog === null) return 1;
  io.out(
    statuses === null
      ? reading(runLog ?? "", runId)
      : combinedReading(runLog, runId, statuses),
  );
  return 0;
}

if (import.meta.main)
  runMain("parse-ci-log", () => main(process.argv.slice(2)));
