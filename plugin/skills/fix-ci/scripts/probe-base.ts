#!/usr/bin/env bun
/**
 * Fresh-base probe: run a failing check again on a freshly fetched base, in a
 * throwaway worktree, so the failure is attributed before anyone fixes it.
 *
 * Usage: bun probe-base.ts --base <branch> --expect <text> [--junit <report>] [--remote <name>] [--timeout <seconds>] [--setup <command>] -- <command> [args...]
 *   Run from inside the repository whose check failed. The command is spawned
 *   as given (no shell) with the throwaway worktree as its working directory,
 *   so `-- bun test src/cart.test.ts` runs that file against the base.
 *
 *   `--expect` is text the failure shows in CI. A command that fails on the
 *   base proves only that something failed there: a missing install, an
 *   import error, a test runner that found nothing, or another test. Text in
 *   the output does not say which test failed either, since a passing test
 *   prints its name too.
 *
 *   For a test, name the JUnit report the command writes with `--junit`, a
 *   path inside the worktree, and give the failing test's name as
 *   `--expect`: the verdict is then that test case's own result on the base.
 *   It failed there: pre-existing. It passed: the change's, whatever else
 *   failed beside it. The cases named exactly the text are read when there
 *   are any, otherwise the cases whose name holds it. A report already at
 *   that path on the base is removed before the command runs. A report the
 *   command did not write, one that is not well-formed JUnit or not a file
 *   inside the worktree, no case by that name, cases by that name with
 *   different results (a skipped one among them), or only skipped ones: no
 *   answer.
 *
 *   Without `--junit`, for a check that writes no per-case report (a type
 *   check, a lint, a build), `--expect` is the error message itself, and the
 *   failure is called pre-existing only when the command fails on the base
 *   and its output shows that text too; a failure that does not is no
 *   answer. A test's name is not evidence there.
 *
 *   The worktree starts with nothing installed: no node_modules, no virtual
 *   environment, no vendor directory. `--setup` names the repository's install
 *   command, run through the shell in the worktree before the command
 *   (`--setup "bun install --frozen-lockfile"`); a setup that fails is no
 *   answer. Install into the worktree itself: an install that links the
 *   package to the working checkout (an editable install, a workspace link)
 *   runs the change's code against the base's test and gets the verdict
 *   backwards.
 *
 * The base is fetched first, into a ref of this run's own, and the probe
 * checks out the commit that ref names: never the remote-tracking ref already
 * present locally, which is only as fresh as the last fetch, so a failure
 * already fixed on the base would still fail here and be misread as
 * pre-existing; and never FETCH_HEAD, which another fetch in the same
 * checkout can overwrite between the fetch and the read. The checkout the command is run from is never
 * touched: no stash, no checkout, no reset; the worktree is removed afterwards
 * whatever happened.
 *
 * Output: one JSON line on stdout with the base, the commit probed, the
 * command, its exit status on the base and the verdict; the tail of the
 * command's own output goes to stderr as evidence.
 *
 * Exit codes: 0 the failure belongs to the change: the named test case passed
 * on the base or, without a report, the command did; 1 the failure is
 * pre-existing: the named test case failed on the base or, without a report,
 * the command failed there showing the expected text; 2 could not decide: a
 * usage error, not a git repository, the fetch failed, the worktree could not
 * be created, the setup failed, the command could not start, the report gave
 * no answer for the named case, the command failed on the base without
 * showing the expected text, or a git call, the setup or the command ran over
 * its `--timeout`, which bounds each of them on its own rather than the probe
 * as a whole. A fetch that fails is no answer.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  JunitReportError,
  parseJunitReport,
} from "../../../shared/junit-report.ts";
import { fail, runMain } from "../../../shared/cli.ts";
import { withoutLeakyGitEnv } from "../../../shared/guarded-git-spawn.ts";

/** Lines of the command's output kept as evidence, per stream. */
const TAIL_LINES = 60;
const DEFAULT_TIMEOUT_SECONDS = 900;
/** Enough for a whole suite's output; a child that writes more fails to start, which the probe reports. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const USAGE =
  "usage: probe-base.ts --base <branch> --expect <text> [--junit <report>] [--remote <name>] [--timeout <seconds>] [--setup <command>] -- <command> [args...]";

export interface ProbeArgs {
  base: string;
  /** Text the failure shows in CI, which the base's output must show for a pre-existing verdict. */
  expect: string;
  /** The JUnit report the command writes, relative to the worktree; the verdict then reads the case `expect` names. */
  junit: string | undefined;
  remote: string;
  timeoutSeconds: number;
  /** The install command run through the shell in the worktree first, if any. */
  setup: string | undefined;
  command: string[];
}

/** The value after an option that takes one; a missing value is a usage error. */
function optionValue(arg: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--"))
    fail(2, `${arg} needs a value`, USAGE);
  return value;
}

function timeoutValue(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) <= 0)
    fail(
      2,
      `--timeout takes a positive number of seconds, got ${value}`,
      USAGE,
    );
  return Number(value);
}

/** The options that take a value, and where each value goes. */
const OPTIONS: Record<
  string,
  (into: Partial<ProbeArgs>, value: string) => void
> = {
  "--base": (into, value) => {
    into.base = value;
  },
  "--expect": (into, value) => {
    into.expect = value;
  },
  "--junit": (into, value) => {
    if (isAbsolute(value) || value.split(/[\\/]/).includes(".."))
      fail(
        2,
        `--junit names a report inside the worktree, got ${value}: a report outside it can be one an earlier run left`,
        USAGE,
      );
    into.junit = value;
  },
  "--remote": (into, value) => {
    into.remote = value;
  },
  "--setup": (into, value) => {
    into.setup = value;
  },
  "--timeout": (into, value) => {
    into.timeoutSeconds = timeoutValue(value);
  },
};

/** The options before `--`, and the index of the `--` (or the end). */
function readOptions(argv: string[]): {
  into: Partial<ProbeArgs>;
  end: number;
} {
  const into: Partial<ProbeArgs> = {};
  let i = 0;
  for (; i < argv.length && argv[i] !== "--"; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") fail(0, USAGE);
    const set = Object.hasOwn(OPTIONS, arg) ? OPTIONS[arg] : undefined;
    if (set === undefined)
      fail(2, `unknown argument ${arg}; the command goes after --`, USAGE);
    i++;
    set(into, optionValue(arg, argv[i]));
  }
  return { into, end: i };
}

/** Parse argv; a usage error throws exit 2 with the message. */
export function parseArgs(argv: string[]): ProbeArgs {
  const { into, end } = readOptions(argv);
  // Past the `--`, or at the end when there was none.
  const command = argv.slice(end + 1);
  const { base, expect } = into;
  if (base === undefined) fail(2, "--base <branch> is required", USAGE);
  if (expect === undefined || !expect.trim())
    fail(
      2,
      "--expect <text> is required: the failing test's name or the error CI showed",
      USAGE,
    );
  if (command.length === 0) fail(2, "no command given after --", USAGE);
  return {
    base,
    expect,
    junit: into.junit,
    remote: into.remote ?? "origin",
    timeoutSeconds: into.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    setup: into.setup,
    command,
  };
}

/**
 * The environment without the variables that route git at another
 * repository: a hook manager exports them, and inheriting them would make the
 * probe's worktree commands act on the hook's repository. The command under
 * probe gets the same cleaned environment, since it may run git itself.
 */
function cleanEnv(): Record<string, string> {
  return withoutLeakyGitEnv();
}

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException | undefined;
}

/** Where git runs, with what environment, and how long it may take. */
interface GitContext {
  env: Record<string, string>;
  timeoutSeconds: number;
}

function git(cwd: string, ctx: GitContext, args: string[]): Run {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...ctx.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: ctx.timeoutSeconds * 1000,
    killSignal: "SIGKILL",
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

/** The fields of a spawn result the probe reads, with absent streams as empty text. */
function asRun(r: SpawnSyncReturns<string>): Run {
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

function tail(output: string): string {
  const lines = output.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(-TAIL_LINES);
  const dropped = lines.length - kept.length;
  return (dropped > 0 ? [`... ${dropped} earlier lines`, ...kept] : kept).join(
    "\n",
  );
}

function reportOutput(label: string, r: Run): void {
  console.error(`--- ${label}: stdout ---`);
  if (r.stdout.length > 0) console.error(tail(r.stdout));
  console.error(`--- ${label}: stderr ---`);
  if (r.stderr.length > 0) console.error(tail(r.stderr));
}

function describeGitFailure(what: string, r: Run): string {
  const reason =
    r.error?.code === "ETIMEDOUT"
      ? "git ran over the deadline and was killed"
      : r.error !== undefined
        ? r.error.message
        : r.stderr.trim() || `exit ${r.status ?? `signal ${r.signal}`}`;
  return `${what}: ${reason}`;
}

/**
 * The commit the base names after a fresh fetch into `ref`, a ref of this
 * run's own; a fetch that fails is no answer.
 */
function freshBaseCommit(
  repo: string,
  ctx: GitContext,
  args: ProbeArgs,
  ref: string,
): string {
  const fetch = git(repo, ctx, [
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    args.remote,
    `+${args.base}:${ref}`,
  ]);
  if (fetch.status !== 0)
    fail(
      2,
      describeGitFailure(
        `could not decide: fetching ${args.remote} ${args.base} failed, so the base is not fresh and a fetch that fails is no answer`,
        fetch,
      ),
    );
  const head = git(repo, ctx, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (head.status !== 0)
    fail(
      2,
      describeGitFailure(
        `could not decide: ${args.remote} ${args.base} fetched but names no commit`,
        head,
      ),
    );
  return head.stdout.trim();
}

/**
 * The exit status of a run that completed; exit 2 when it did not: it could
 * not start, the deadline killed it, or a signal did.
 */
function completedStatus(what: string, r: Run, timeoutSeconds: number): number {
  if (r.error?.code === "ETIMEDOUT")
    fail(
      2,
      `could not decide: ${what} ran over the ${timeoutSeconds}s deadline on the base and was killed`,
    );
  if (r.error !== undefined)
    fail(
      2,
      `could not decide: ${what} could not run on the base: ${r.error.message}`,
    );
  if (r.status === null)
    fail(
      2,
      `could not decide: ${what} was terminated by signal ${r.signal} on the base`,
    );
  return r.status;
}

interface Limits {
  cwd: string;
  env: Record<string, string>;
  encoding: "utf8";
  timeout: number;
  killSignal: "SIGKILL";
  maxBuffer: number;
}

/** Run the setup command through the shell in the worktree; a setup that fails is no answer. */
function runSetup(setup: string, where: string, limits: Limits): void {
  const s = asRun(spawnSync(setup, { ...limits, shell: true }));
  reportOutput(`setup ${where}`, s);
  const status = completedStatus("the setup command", s, limits.timeout / 1000);
  if (status !== 0)
    fail(
      2,
      `could not decide: the setup command failed on the base (exit ${status}), so the command was not run there`,
    );
}

/** Run `fn` with a throwaway worktree at `commit`, removed afterwards whatever happened. */
function withWorktree<T>(
  repo: string,
  ctx: GitContext,
  commit: string,
  fn: (probe: string) => T,
): T {
  const scratch = mkdtempSync(join(tmpdir(), "fresh-base-"));
  const probe = join(scratch, "base");
  try {
    const add = git(repo, ctx, [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      probe,
      commit,
    ]);
    if (add.status !== 0)
      fail(
        2,
        describeGitFailure(
          `could not decide: no throwaway worktree at ${commit}`,
          add,
        ),
      );
    return fn(probe);
  } finally {
    const remove = git(repo, ctx, ["worktree", "remove", "--force", probe]);
    if (remove.status !== 0) {
      rmSync(probe, { recursive: true, force: true });
      git(repo, ctx, ["worktree", "prune"]);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const env = cleanEnv();
  const ctx: GitContext = { env, timeoutSeconds: args.timeoutSeconds };

  const top = git(process.cwd(), ctx, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0)
    fail(
      2,
      describeGitFailure("could not decide: not inside a git repository", top),
    );
  const repo = top.stdout.trim();
  const ref = `refs/probe-base/${process.pid}-${randomUUID()}`;
  try {
    const commit = freshBaseCommit(repo, ctx, args, ref);
    return probeAt(repo, ctx, args, commit);
  } finally {
    git(repo, ctx, ["update-ref", "-d", ref]);
  }
}

/** One test case of a JUnit report: its name, and whether it failed or was skipped. */
export interface JunitCase {
  name: string;
  failed: boolean;
  skipped: boolean;
}

/**
 * The test cases of a JUnit report, read by the plugin's strict JUnit reader:
 * captured output, a comment or a CDATA section that quotes a case or a
 * failure is text, never a case. A report that is not well-formed or not
 * JUnit is no answer.
 */
export function junitCases(xml: string, report = "the report"): JunitCase[] {
  try {
    return parseJunitReport(xml).cases.map(({ name, failed, skipped }) => ({
      name,
      failed,
      skipped,
    }));
  } catch (error) {
    if (error instanceof JunitReportError)
      fail(
        2,
        `could not decide: ${report} could not be read: ${error.message}`,
      );
    throw error;
  }
}

type CaseResult = "failed" | "passed" | "skipped";
const resultOf = (c: JunitCase): CaseResult =>
  c.skipped ? "skipped" : c.failed ? "failed" : "passed";

/**
 * The verdict a JUnit report gives for the case `expect` names: the cases
 * named exactly that when there are any, otherwise the cases whose name holds
 * it. Exit 2 when it gives none: no such case, cases with different results
 * (a skipped one among them is a case that never ran), or only skipped ones.
 */
export function junitVerdict(
  cases: JunitCase[],
  expect: string,
  report: string,
): "change" | "pre-existing" {
  const exact = cases.filter((c) => c.name === expect);
  const named =
    exact.length > 0 ? exact : cases.filter((c) => c.name.includes(expect));
  const quoted = JSON.stringify(expect);
  if (named.length === 0)
    fail(
      2,
      `could not decide: ${report} lists no test case whose name holds ${quoted}, so that test did not run on the base`,
    );
  const results = new Set(named.map(resultOf));
  if (results.size > 1)
    fail(
      2,
      `could not decide: ${quoted} names ${named.length} test cases in ${report} with different results (${[...results].sort().join(", ")}); name the failing case exactly`,
    );
  const [result] = results;
  if (result === "skipped")
    fail(
      2,
      `could not decide: every test case named ${quoted} in ${report} was skipped on the base`,
    );
  return result === "failed" ? "pre-existing" : "change";
}

/** Whether `path` resolves inside `root`, both through their symbolic links. */
function resolvesInside(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The nearest directory of `path` that exists, `path` excluded. */
function existingParent(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir)) dir = dirname(dir);
  return dir;
}

/**
 * Remove a report the base already holds at `report`, so only a report this
 * run's command writes is read: a tracked report, or one the setup wrote,
 * would otherwise stand in for a command that failed before writing its own.
 * A symbolic link there is removed as a link; a parent directory that leads
 * outside the worktree is no answer, and nothing outside it is touched.
 */
function clearReport(probe: string, report: string): void {
  const path = join(probe, report);
  if (!resolvesInside(probe, existingParent(path)))
    fail(
      2,
      `could not decide: ${report} lies under a link that leads outside the worktree on the base`,
    );
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isDirectory())
    fail(2, `could not decide: ${report} is a directory on the base`);
  rmSync(path);
}

/** The verdict from the report the command wrote in the worktree; exit 2 when there is none. */
function verdictFromReport(
  probe: string,
  report: string,
  expect: string,
): "change" | "pre-existing" {
  const path = join(probe, report);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined)
    fail(
      2,
      `could not decide: the command wrote no JUnit report at ${report} on the base`,
    );
  if (!stat.isFile() || !resolvesInside(probe, dirname(path)))
    fail(
      2,
      `could not decide: ${report} on the base is not a file inside the worktree (a link, a directory, or under a link that leads out)`,
    );
  return junitVerdict(
    junitCases(readFileSync(path, "utf8"), report),
    expect,
    report,
  );
}

/** The verdict from the command's output alone: failed, and showing the expected text. */
function verdictFromOutput(
  run: Run,
  status: number,
  expect: string,
): "change" | "pre-existing" {
  if (status === 0) return "change";
  if (!`${run.stdout}\n${run.stderr}`.includes(expect))
    fail(
      2,
      `could not decide: the command failed on the base (exit ${status}), but its output does not show ${JSON.stringify(expect)}: a different failure (an install, an import, a runner that found nothing, another test) is no answer`,
    );
  return "pre-existing";
}

/** Run the setup and the command at `commit`, and turn the result into a verdict. */
function probeAt(
  repo: string,
  ctx: GitContext,
  args: ProbeArgs,
  commit: string,
): number {
  const { env } = ctx;
  return withWorktree(repo, ctx, commit, (probe) => {
    const where = `on ${args.remote}/${args.base} at ${commit.slice(0, 12)}`;
    const limits: Limits = {
      cwd: probe,
      env,
      encoding: "utf8",
      timeout: args.timeoutSeconds * 1000,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
    };
    if (args.setup !== undefined) runSetup(args.setup, where, limits);
    if (args.junit !== undefined) clearReport(probe, args.junit);

    const [executable, ...rest] = args.command;
    const run = asRun(spawnSync(executable as string, rest, limits));
    reportOutput(where, run);
    const status = completedStatus("the command", run, args.timeoutSeconds);
    const verdict =
      args.junit === undefined
        ? verdictFromOutput(run, status, args.expect)
        : verdictFromReport(probe, args.junit, args.expect);
    console.log(
      JSON.stringify({
        base: `${args.remote}/${args.base}`,
        base_commit: commit,
        setup: args.setup ?? null,
        expect: args.expect,
        evidence: args.junit === undefined ? "output" : "junit",
        junit: args.junit ?? null,
        command: args.command,
        command_exit: status,
        verdict,
      }),
    );
    return verdict === "change" ? 0 : 1;
  });
}

if (import.meta.main) runMain("probe-base", main);
