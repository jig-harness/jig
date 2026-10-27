#!/usr/bin/env bun
/**
 * The evidence record: run a command and keep the proof that it ran, tied to
 * the exact tree it ran against.
 *
 * Usage:
 *   bun evidence.ts run [--timeout <minutes>] [--junit <path>] [--name <display name>]
 *                       [--expect-fail [<case>]] [--json] -- <command> [args...]
 *   bun evidence.ts list [--tree <hash>] [--command <hash>] [--all] [--json]
 *
 * `run` spawns the command as given (no shell) from the current directory,
 * writes one record and prints a short block:
 *
 *   EVIDENCE  tree 3f9c2a1  gates
 *   exit 0  ·  2m14s  ·  412 cases ran, 0 skipped (junit: .reports/junit.xml)
 *   record ~/.local/state/jig/evidence/example-web/<tree>/<command>/20261023T141502-4b7e.json
 *
 *   --timeout <minutes>   The deadline, a positive number of minutes (0.5 is
 *                         thirty seconds); default `verify.timeout_minutes`.
 *                         At the deadline the command's whole process tree is
 *                         ended and the run is recorded as timed out, never as
 *                         a pass or a failure.
 *   --junit <path>        The JUnit report the command writes, relative to the
 *                         current directory. The counts come from it alone.
 *   --name <name>         The display name the block shows for the command
 *                         (the validation plan's name for the check); without
 *                         it, the program's name and the command hash.
 *   --expect-fail [<case>]  The run must exit non-zero: the seen-to-fail record
 *                         of a new test. With a case (its `name`, or
 *                         `<classname>::<name>`), every case of that name must
 *                         be failed in this run's report, so `--junit` is
 *                         required.
 *   --json                Print the record instead of the block.
 *
 * `list` prints the records of a tree (default: the tree as it is now), the
 * newest per command that vouches for its tree; `--all` prints every run, a
 * `tree-changed` one included and marked. `--tree` takes a full hash or a
 * prefix of at least four characters, `--command` a command hash or a prefix.
 *
 * The tree is the tree hash of everything Git tracks or would track: `HEAD`,
 * with every staged and unstaged change and every untracked file Git does not
 * ignore, written through a temporary index (`GIT_INDEX_FILE`, then
 * `read-tree HEAD`, `add -A`, `write-tree`), so the real index is never
 * touched. It is taken before and after the run; a pair that differs is
 * recorded as `tree-changed`, and lookup never returns that record as proof.
 * Ignored files are outside the identity, and the record's `scope` says so;
 * so a report path the command writes belongs in an ignored folder, or the
 * report itself changes the tree.
 *
 * Every run writes its own record and never overwrites another:
 * `<store>/<repository>/<tree>/<command hash>/<run id>.json`, with the full
 * output beside it as `<run id>.log`. The store is `verify.store`, default
 * `~/.local/state/jig/evidence`. A report found at the `--junit` path before
 * the run is moved beside the record (`<run id>.previous-report`), and the
 * report is read only when one is there again, written after the run began;
 * a run that leaves none is recorded as `no report`.
 *
 * The block names no argument of the command and holds no output: test output
 * and command lines can carry credentials, so both stay in the record on this
 * machine, and the block is what travels.
 *
 * Exit codes: 0 the record vouches for what was asked (a pass, or with
 * `--expect-fail` a seen-to-fail) on an unchanged tree, with a fresh report
 * in which every top-level suite ran a case when `--junit` was given; 1 a
 * record was written that does not (a failure, a timeout, a changed tree, no
 * report or a stale one, a suite that ran nothing, a failed expectation, a
 * command that could not start); 2 nothing was recorded: a usage or
 * configuration error, or not inside a Git repository. `list` exits 0, or 2
 * on such an error.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fail, runMain } from "./cli.ts";
import { type Clock, systemClock } from "./clock.ts";
import { consumerRoot, layeredConfig, withSource } from "./consumer.ts";
import { errnoCode } from "./errors.ts";
import {
  type EvidenceRecord,
  EvidenceError,
  formatBlock,
  judgeExpectation,
  lookup,
  type Outcome,
  readReport,
  type VerifySettings,
  verifySettings,
  vouches,
} from "./evidence-record.ts";
import { withoutLeakyGitEnv } from "./guarded-git-spawn.ts";
import { type RunResult, run } from "./proc.ts";

const USAGE = [
  "usage: evidence.ts run [--timeout <minutes>] [--junit <path>] [--name <display name>] [--expect-fail [<case>]] [--json] -- <command> [args...]",
  "       evidence.ts list [--tree <hash>] [--command <hash>] [--all] [--json]",
];

/** The longest deadline a timer can hold: 2^31 - 1 milliseconds. */
const MAX_TIMEOUT_MINUTES = 35_791;
/** Each git call of the tree identity; a large tree is hashed file by file. */
const GIT_TIMEOUT_SEC = 600;
const SCOPE =
  "the files Git tracks or would track: HEAD, every staged and unstaged change to a tracked file, and every untracked file Git does not ignore. Ignored files (installed dependencies, build output, caches) are outside the identity, and this record does not vouch for them.";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function readSettings(root: string): VerifySettings {
  let values: Record<string, unknown>;
  try {
    values = layeredConfig(root).values;
  } catch (error) {
    fail(2, `evidence: ${message(error)}`);
  }
  try {
    return verifySettings(values.verify, root);
  } catch (error) {
    fail(2, `evidence: ${withSource(values, "verify", error).message}`);
  }
}

// ---------------------------------------------------------------- arguments

interface RunArgs {
  timeoutMinutes: number | undefined;
  junit: string | undefined;
  name: string | undefined;
  expectFail: { case: string | null } | null;
  json: boolean;
  command: string[];
}

interface ListArgs {
  tree: string | undefined;
  command: string | undefined;
  all: boolean;
  json: boolean;
}

function value(argv: string[], i: number, flag: string): string {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--"))
    fail(2, `evidence: ${flag} needs a value`, ...USAGE);
  return next;
}

function minutes(raw: string): number {
  const n = Number(raw);
  if (!/^[0-9]*\.?[0-9]+$/.test(raw) || !(n > 0) || n > MAX_TIMEOUT_MINUTES)
    fail(
      2,
      `evidence: --timeout takes a positive number of minutes up to ${MAX_TIMEOUT_MINUTES}, got ${raw}`,
      ...USAGE,
    );
  return n;
}

/** The option of `run` at `argv[i]`; returns how many arguments it took. */
function runOption(argv: string[], i: number, args: RunArgs): number {
  const arg = argv[i] as string;
  if (arg === "--json") {
    args.json = true;
    return 1;
  }
  if (arg === "--expect-fail") {
    const next = argv[i + 1];
    const named = next !== undefined && !next.startsWith("--");
    args.expectFail = { case: named ? next : null };
    return named ? 2 : 1;
  }
  if (arg === "--timeout") args.timeoutMinutes = minutes(value(argv, i, arg));
  else if (arg === "--junit") args.junit = value(argv, i, arg);
  else if (arg === "--name") args.name = value(argv, i, arg);
  else
    fail(
      2,
      `evidence: unknown argument ${arg}; the command goes after --`,
      ...USAGE,
    );
  return 2;
}

function parseRunArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    timeoutMinutes: undefined,
    junit: undefined,
    name: undefined,
    expectFail: null,
    json: false,
    command: [],
  };
  let i = 0;
  while (i < argv.length && argv[i] !== "--") i += runOption(argv, i, args);
  args.command = argv.slice(i + 1);
  if (args.command.length === 0)
    fail(2, "evidence: no command given after --", ...USAGE);
  if (args.expectFail?.case && args.junit === undefined)
    fail(
      2,
      "evidence: --expect-fail <case> reads the case's result from the report, so --junit <path> is required",
      ...USAGE,
    );
  return args;
}

function hashPrefix(raw: string, flag: string): string {
  if (!/^[0-9a-f]{4,64}$/.test(raw))
    fail(
      2,
      `evidence: ${flag} takes a hexadecimal hash or a prefix of at least 4 characters, got ${raw}`,
      ...USAGE,
    );
  return raw;
}

function parseListArgs(argv: string[]): ListArgs {
  const args: ListArgs = {
    tree: undefined,
    command: undefined,
    all: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--tree") args.tree = hashPrefix(value(argv, i++, arg), arg);
    else if (arg === "--command")
      args.command = hashPrefix(value(argv, i++, arg), arg);
    else if (arg === "--all") args.all = true;
    else if (arg === "--json") args.json = true;
    else fail(2, `evidence: unknown argument ${arg}`, ...USAGE);
  }
  return args;
}

// ---------------------------------------------------------------- the tree

/** Git's environment without the variables that would route it at another repository. */
function gitEnv(): Record<string, string> {
  return { ...withoutLeakyGitEnv(), GIT_TERMINAL_PROMPT: "0" };
}

async function git(
  root: string,
  args: string[],
  env: Record<string, string> = gitEnv(),
): Promise<string> {
  const r = await run(["git", ...args], {
    cwd: root,
    env,
    timeoutSec: GIT_TIMEOUT_SEC,
  });
  if (r.code !== 0)
    throw new EvidenceError(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * The tree hash of the working tree Git tracks or would track, written
 * through a temporary index so the real one is untouched. Reading `HEAD`
 * first keeps a tracked file that now matches an ignore rule or sits outside
 * a sparse checkout; an unborn `HEAD` starts from the empty tree.
 */
async function treeIdentity(root: string): Promise<string> {
  const index = join(
    tmpdir(),
    `jig-evidence-index-${randomBytes(6).toString("hex")}`,
  );
  const env = { ...gitEnv(), GIT_INDEX_FILE: index };
  try {
    const head = await run(["git", "rev-parse", "--verify", "-q", "HEAD"], {
      cwd: root,
      env,
      timeoutSec: GIT_TIMEOUT_SEC,
    });
    const start = head.code === 0 ? "HEAD" : "--empty";
    await git(root, ["read-tree", start], env);
    await git(root, ["add", "-A"], env);
    return await git(root, ["write-tree"], env);
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

async function identityOrFail(root: string): Promise<string> {
  try {
    return await treeIdentity(root);
  } catch (error) {
    fail(
      2,
      `evidence: cannot take the tree identity of ${root}, and a record is tied to a Git tree: ${message(error)}`,
    );
  }
}

/** The clone's name: the folder holding its common Git directory. */
async function repositoryName(root: string): Promise<string> {
  const common = await git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const name =
    basename(common) === ".git"
      ? basename(dirname(common))
      : basename(common).replace(/\.git$/, "");
  return name.replace(/[^A-Za-z0-9._-]/g, "_") || "repository";
}

// ---------------------------------------------------------------- running

/** Move a report already at the path beside the record, so it is never read as this run's. */
function moveAside(path: string, to: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    renameSync(path, to);
  } catch (error) {
    if (errnoCode(error) !== "EXDEV") throw error;
    copyFileSync(path, to);
    rmSync(path, { force: true });
  }
  return to;
}

/** Reserve a run id in `dir` by creating its output file exclusively, so no run overwrites another. */
function reserve(dir: string, clock: Clock): { id: string; fd: number } {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(clock.now())
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 15);
  for (;;) {
    const id = `${stamp}-${randomBytes(2).toString("hex")}`;
    try {
      return { id, fd: openSync(join(dir, `${id}.log`), "wx") };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
}

/** The first and last `n` lines of the output, without overlap. */
function headAndTail(
  text: string,
  n: number,
): Omit<EvidenceRecord["output"], "file"> {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return {
    lines: lines.length,
    head: lines.slice(0, n),
    tail: lines.slice(Math.max(n, lines.length - n)),
  };
}

/** The command's identity: its arguments and where in the repository it ran. */
function commandHash(argv: string[], cwd: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ cwd, argv }))
    .digest("hex")
    .slice(0, 12);
}

function baseOutcome(r: RunResult): Outcome {
  if (r.spawnFailed) return "could-not-start";
  if (r.timedOut) return "timed-out";
  if (r.bufferExceeded) return "killed-for-output";
  return r.code === 0 ? "pass" : "fail";
}

const posix = (path: string) => path.split("\\").join("/");

interface Report {
  file: string;
  shown: string;
  movedAside: string | undefined;
}

/** Where the run is, what it is called and where its record goes. */
async function prepare(args: RunArgs, clock: Clock) {
  const root = consumerRoot();
  const settings = readSettings(root);
  const cwd = process.cwd();
  const cwdRel = posix(relative(root, cwd)) || ".";
  const hash = commandHash(args.command, cwdRel);
  const program = basename(args.command[0] as string).replace(
    /\.(exe|cmd|bat)$/i,
    "",
  );
  const tree = await identityOrFail(root);
  const repository = await repositoryName(root);
  const dir = join(settings.store, repository, tree, hash);
  const { id, fd } = reserve(dir, clock);
  let report: Report | undefined;
  if (args.junit !== undefined) {
    const file = resolve(cwd, args.junit);
    report = {
      file,
      shown: posix(relative(root, file)),
      movedAside: moveAside(file, join(dir, `${id}.previous-report`)),
    };
  }
  const command = {
    hash,
    display: args.name ?? `${program} ${hash}`,
    argv: args.command,
    cwd: cwdRel,
  };
  return {
    root,
    settings,
    cwd,
    tree,
    repository,
    dir,
    id,
    fd,
    report,
    command,
  };
}

async function runCommand(args: RunArgs, clock: Clock): Promise<number> {
  const p = await prepare(args, clock);
  const timeoutMinutes = args.timeoutMinutes ?? p.settings.timeoutMinutes;
  let output = "";
  const startedMs = clock.now();
  const result = await run(args.command, {
    cwd: p.cwd,
    env: process.env,
    timeoutSec: timeoutMinutes * 60,
    onOutput: (_stream, text) => {
      output += text;
    },
  });
  const endedMs = clock.now();
  writeFileSync(p.fd, output);
  closeSync(p.fd);
  const treeAfter = await identityOrFail(p.root);
  const junit = p.report
    ? {
        ...readReport(p.report.file, p.report.shown, startedMs),
        ...(p.report.movedAside ? { movedAside: p.report.movedAside } : {}),
      }
    : null;
  const ran = baseOutcome(result);
  const expectFail =
    args.expectFail && judgeExpectation(args.expectFail, ran, junit);
  const expected = expectFail?.met ? "seen-to-fail" : "expectation-failed";
  const record: EvidenceRecord = {
    schema: "jig-evidence/v1",
    id: p.id,
    repository: p.repository,
    tree: p.tree,
    treeAfter,
    treeChanged: p.tree !== treeAfter,
    scope: SCOPE,
    command: p.command,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: endedMs - startedMs,
    timeoutMinutes,
    // No exit code where the child did not exit on its own: it never
    // started, was ended at the deadline or for its output, or by a signal.
    exit:
      ran === "pass" || (ran === "fail" && !result.signal) ? result.code : null,
    signal: result.signal ?? null,
    outcome: expectFail ? expected : ran,
    expectFail,
    junit,
    output: {
      ...headAndTail(output, p.settings.outputLines),
      file: `${p.id}.log`,
    },
  };
  const path = join(p.dir, `${p.id}.json`);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  console.log(
    args.json ? JSON.stringify(record, null, 2) : formatBlock(record, path),
  );
  return vouches(record) ? 0 : 1;
}

// ---------------------------------------------------------------- lookup

async function listRecords(args: ListArgs): Promise<number> {
  const root = consumerRoot();
  const settings = readSettings(root);
  const tree = args.tree ?? (await identityOrFail(root));
  const repository = await repositoryName(root);
  let found: ReturnType<typeof lookup>;
  try {
    found = lookup(join(settings.store, repository), tree, {
      ...(args.command ? { command: args.command } : {}),
      all: args.all,
    });
  } catch (error) {
    fail(2, `evidence: ${message(error)}`);
  }
  if (args.json)
    console.log(
      JSON.stringify(
        found.map((f) => ({ ...f.record, path: f.path })),
        null,
        2,
      ),
    );
  else if (found.length === 0)
    console.log(`no evidence record for tree ${tree.slice(0, 7)}`);
  else
    console.log(found.map((f) => formatBlock(f.record, f.path)).join("\n\n"));
  return 0;
}

async function main(argv: string[], clock: Clock): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "run") return runCommand(parseRunArgs(rest), clock);
  if (verb === "list") return listRecords(parseListArgs(rest));
  if (verb === "-h" || verb === "--help") fail(0, ...USAGE);
  fail(2, `evidence: unknown command ${verb ?? "(none)"}`, ...USAGE);
}

if (import.meta.main)
  runMain("evidence", () => main(process.argv.slice(2), systemClock));
