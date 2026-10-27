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
  lookup,
  readReport,
  type ReportSummary,
  settle,
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

/** A flag takes a value, takes none, or takes one when the next word is not a flag. */
type FlagKind = "value" | "switch" | "optional";
type Flags = Map<string, string | true>;

const RUN_FLAGS: Record<string, FlagKind> = {
  "--timeout": "value",
  "--junit": "value",
  "--name": "value",
  "--expect-fail": "optional",
  "--json": "switch",
};
const LIST_FLAGS: Record<string, FlagKind> = {
  "--tree": "value",
  "--command": "value",
  "--all": "switch",
  "--json": "switch",
};

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

/** The flag at `argv[i]`: its value and how many words it took. */
function takeFlag(
  argv: string[],
  i: number,
  spec: Record<string, FlagKind>,
): { value: string | true; width: number } {
  const arg = argv[i] as string;
  const kind = Object.hasOwn(spec, arg) ? spec[arg] : undefined;
  const next = argv[i + 1];
  const hasValue = next !== undefined && !next.startsWith("--");
  if (kind === "switch" || (kind === "optional" && !hasValue))
    return { value: true, width: 1 };
  if (kind !== undefined && hasValue) return { value: next, width: 2 };
  const problem = kind ? `${arg} needs a value` : `unknown argument ${arg}`;
  fail(2, `evidence: ${problem}`, ...USAGE);
}

/** The flags before `--` (or the end), and the index where they stop. */
function readFlags(
  argv: string[],
  spec: Record<string, FlagKind>,
): { flags: Flags; end: number } {
  const flags: Flags = new Map();
  let i = 0;
  while (i < argv.length && argv[i] !== "--") {
    const { value, width } = takeFlag(argv, i, spec);
    flags.set(argv[i] as string, value);
    i += width;
  }
  return { flags, end: i };
}

const text = (value: string | true | undefined) =>
  typeof value === "string" ? value : undefined;

function minutes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (/^[0-9]*\.?[0-9]+$/.test(raw) && n > 0 && n <= MAX_TIMEOUT_MINUTES)
    return n;
  fail(
    2,
    `evidence: --timeout takes a positive number of minutes up to ${MAX_TIMEOUT_MINUTES}, got ${raw}`,
    ...USAGE,
  );
}

function hashPrefix(raw: string | undefined, flag: string): string | undefined {
  if (raw === undefined || /^[0-9a-f]{4,64}$/.test(raw)) return raw;
  fail(
    2,
    `evidence: ${flag} takes a hexadecimal hash or a prefix of at least 4 characters, got ${raw}`,
    ...USAGE,
  );
}

/** `run`'s arguments; a usage error exits 2. */
export function parseRunArgs(argv: string[]): RunArgs {
  const { flags, end } = readFlags(argv, RUN_FLAGS);
  const expectFail = flags.get("--expect-fail");
  const args: RunArgs = {
    timeoutMinutes: minutes(text(flags.get("--timeout"))),
    junit: text(flags.get("--junit")),
    name: text(flags.get("--name")),
    expectFail:
      expectFail === undefined ? null : { case: text(expectFail) ?? null },
    json: flags.has("--json"),
    command: argv.slice(end + 1),
  };
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

/** `list`'s arguments; a usage error exits 2. */
export function parseListArgs(argv: string[]): ListArgs {
  const { flags, end } = readFlags(argv, LIST_FLAGS);
  if (end < argv.length) fail(2, "evidence: list takes no command", ...USAGE);
  return {
    tree: hashPrefix(text(flags.get("--tree")), "--tree"),
    command: hashPrefix(text(flags.get("--command")), "--command"),
    all: flags.has("--all"),
    json: flags.has("--json"),
  };
}

// ---------------------------------------------------------------- the tree

/** Git's environment without the variables that would route it at another repository. */
function gitEnv(): Record<string, string> {
  return { ...withoutLeakyGitEnv(), GIT_TERMINAL_PROMPT: "0" };
}

function gitRun(root: string, args: string[], env: Record<string, string>) {
  return run(["git", ...args], { cwd: root, env, timeoutSec: GIT_TIMEOUT_SEC });
}

async function git(
  root: string,
  args: string[],
  env: Record<string, string> = gitEnv(),
): Promise<string> {
  const r = await gitRun(root, args, env);
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
    const head = await gitRun(
      root,
      ["rev-parse", "--verify", "-q", "HEAD"],
      env,
    );
    await git(root, ["read-tree", head.code === 0 ? "HEAD" : "--empty"], env);
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
  output: string,
  n: number,
): Omit<EvidenceRecord["output"], "file"> {
  const lines = output.split(/\r?\n/);
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

const posix = (path: string) => path.split("\\").join("/");

interface Report {
  file: string;
  shown: string;
  movedAside: string | undefined;
}

/** The report path, with any report already there moved beside the record. */
function prepareReport(
  junit: string | undefined,
  root: string,
  aside: string,
): Report | undefined {
  if (junit === undefined) return undefined;
  const file = resolve(junit);
  return {
    file,
    shown: posix(relative(root, file)),
    movedAside: moveAside(file, aside),
  };
}

/** Where the run is, what it is called and where its record goes. */
async function prepare(args: RunArgs, clock: Clock) {
  const root = consumerRoot();
  const settings = readSettings(root);
  const cwd = posix(relative(root, process.cwd())) || ".";
  const hash = commandHash(args.command, cwd);
  const program = basename(args.command[0] as string);
  const tree = await identityOrFail(root);
  const repository = await repositoryName(root);
  const dir = join(settings.store, repository, tree, hash);
  const { id, fd } = reserve(dir, clock);
  const aside = join(dir, `${id}.previous-report`);
  const command = {
    hash,
    display: args.name ?? `${program.replace(/\.(exe|cmd|bat)$/i, "")} ${hash}`,
    argv: args.command,
    cwd,
  };
  const report = prepareReport(args.junit, root, aside);
  return { root, settings, tree, repository, dir, id, fd, report, command };
}

/** Run the command under its deadline, keeping its output in arrival order. */
async function execute(
  command: string[],
  timeoutMinutes: number,
  clock: Clock,
) {
  let output = "";
  const startedMs = clock.now();
  const result: RunResult = await run(command, {
    env: process.env,
    timeoutSec: timeoutMinutes * 60,
    onOutput: (_stream, chunk) => {
      output += chunk;
    },
  });
  return { result, output, startedMs, endedMs: clock.now() };
}

function reportOf(
  report: Report | undefined,
  startedMs: number,
): ReportSummary | null {
  if (!report) return null;
  const read = readReport(report.file, report.shown, startedMs);
  return report.movedAside ? { ...read, movedAside: report.movedAside } : read;
}

/** Write the record beside its output, whole or not at all. */
function writeRecord(dir: string, record: EvidenceRecord): string {
  const path = join(dir, `${record.id}.json`);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

async function runCommand(args: RunArgs, clock: Clock): Promise<number> {
  const p = await prepare(args, clock);
  const timeoutMinutes = args.timeoutMinutes ?? p.settings.timeoutMinutes;
  const ran = await execute(args.command, timeoutMinutes, clock);
  writeFileSync(p.fd, ran.output);
  closeSync(p.fd);
  const treeAfter = await identityOrFail(p.root);
  const junit = reportOf(p.report, ran.startedMs);
  const record: EvidenceRecord = {
    schema: "jig-evidence/v1",
    id: p.id,
    repository: p.repository,
    tree: p.tree,
    treeAfter,
    treeChanged: p.tree !== treeAfter,
    scope: SCOPE,
    command: p.command,
    startedAt: new Date(ran.startedMs).toISOString(),
    endedAt: new Date(ran.endedMs).toISOString(),
    durationMs: ran.endedMs - ran.startedMs,
    timeoutMinutes,
    ...settle(ran.result, args.expectFail, junit),
    junit,
    output: {
      ...headAndTail(ran.output, p.settings.outputLines),
      file: `${p.id}.log`,
    },
  };
  const path = writeRecord(p.dir, record);
  console.log(
    args.json ? JSON.stringify(record, null, 2) : formatBlock(record, path),
  );
  return vouches(record) ? 0 : 1;
}

// ---------------------------------------------------------------- lookup

type Found = ReturnType<typeof lookup>;

function print(found: Found, tree: string, json: boolean): void {
  if (json)
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
}

async function listRecords(args: ListArgs): Promise<number> {
  const root = consumerRoot();
  const settings = readSettings(root);
  const tree = args.tree ?? (await identityOrFail(root));
  const dir = join(settings.store, await repositoryName(root));
  let found: Found;
  try {
    found = lookup(dir, tree, { command: args.command ?? "", all: args.all });
  } catch (error) {
    fail(2, `evidence: ${message(error)}`);
  }
  print(found, tree, args.json);
  return 0;
}

const VERBS: Record<string, (rest: string[], clock: Clock) => Promise<number>> =
  {
    run: (rest, clock) => runCommand(parseRunArgs(rest), clock),
    list: (rest) => listRecords(parseListArgs(rest)),
  };

async function main(argv: string[], clock: Clock): Promise<number> {
  const [verb = "", ...rest] = argv;
  if (verb === "-h" || verb === "--help") fail(0, ...USAGE);
  const handler = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!handler)
    fail(2, `evidence: unknown command ${verb || "(none)"}`, ...USAGE);
  return handler(rest, clock);
}

if (import.meta.main)
  runMain("evidence", () => main(process.argv.slice(2), systemClock));
