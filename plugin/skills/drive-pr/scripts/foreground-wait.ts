#!/usr/bin/env bun
/**
 * Run a step that can outlive the Bash tool's per-call ceiling from inside a
 * headless driver pass, and block on it within the turn.
 *
 * WHY. A driver pass is a one-shot `claude -p`: the commit and `finish-round.ts`
 * must finish before the turn ends, yet either can exceed one Bash call
 * (`drive-pr-selftest` on commit, the pre-push suite on push). So the step is
 * launched once and waited on as often as the ceiling requires.
 *
 * On POSIX the command stays in the pass's process group, so PASS_DEADLINE
 * and stop signalling reach it. On Windows the launch records the runner's
 * creation identity in the pass's process registry before returning, so the
 * pass can stop its recorded tree after the launcher exits. A descendant
 * which escapes observation remains the residual described below.
 *
 * Raw `spawn` rather than `lib/proc.ts`'s `run()`, on purpose: `run()` blocks
 * until its child exits, and this helper's whole job is to outlive the `launch`
 * call. It is bounded twice instead: by belonging to the pass's cancellation
 * tree (above), which `drive.ts` ends on PASS_DEADLINE/stop, and by the runner's own
 * deadline (`$DRIVE_PR_FOREGROUND_WAIT_TIMEOUT`, default 5400s — the pass's own
 * `$DRIVE_PR_PASS_TIMEOUT` default, so a command cannot outlive the pass that
 * launched it; deliberately NOT the push-only `$DRIVE_PR_PUSH_TIMEOUT`, since
 * the command is often `finish-round.ts`, whose push is one stage among several),
 * which terminates the command's process tree, so a pass that exits after `launch` without ever waiting cannot leave
 * a commit or push running past that point. A timed-out command reports
 * `command-exit: 124`.
 *
 * Usage:
 *   foreground-wait.ts launch -- <command> [args...]   returns at once
 *   foreground-wait.ts wait [--max-sec N]              default 540
 *
 * STATE. Every launch owns one generation directory,
 * `.context/foreground-wait/gen-<n>/` (gitignored), holding that launch's log,
 * pids and result. The directory is the launch claim: `mkdir` is atomic, so of
 * two concurrent launches exactly one creates `gen-<n+1>`, and no launch can
 * touch another's files. The result is published by rename
 * (`result.json.tmp` → `result.json`), so a reader sees all of it or none.
 *
 * EXIT CODES are the helper's own and never a command's: a command's exit
 * status is never returned as this process's, because it would collide with the
 * control codes below. `wait` exits 0 finished with the command exiting 0;
 * 30 finished with command failure or an unwitnessed process tree (the `command-exit:` line carries its
 * status and signal); 20 still running — call `wait` again, never `launch`;
 * 21 nothing of the launch is alive and no result was published; 2 usage / no
 * launch on record. `launch` exits 3 while an earlier launch is running or its tree is unresolved, so a
 * second copy of a push can never start beside the first.
 *
 * LIVENESS is the live (non-zombie) process tree under the launch's recorded
 * pids, read from the native process table, never bare pid existence: an unreaped zombie answers
 * `kill(pid, 0)` forever. RESIDUAL, stated rather than closed: a descendant
 * that outlives BOTH the runner and the command (re-parented to init) is
 * invisible here, as is a command started in the instant between `spawn` and
 * the runner publishing `cmd.pid` if the runner is killed in that instant.
 * Exit 21 therefore says "no recorded process is alive", not "everything the
 * command started has stopped" — the caller's own post-check (`git log`,
 * `finish-round.ts` idempotence) stays the authority before relaunching.
 */
import {
  trackForegroundAnchor,
  type ForegroundTreeState,
} from "./lib/foreground-process-tree.ts";
import {
  claimGenerationLauncher,
  ownsGenerationLauncher,
} from "./lib/foreground-claim.ts";
import { liveOrUnknownTargets } from "../../../shared/process-uncertainty.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { swallow } from "../../../shared/errors.ts";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { testPacing } from "./lib/cli.ts";
import { readTimeoutEnv } from "./lib/proc.ts";
import {
  processTable,
  type ProcessRow,
} from "../../../shared/process-table.ts";
import {
  beginProcessRegistration,
  clearPendingProcessRegistration,
  handoffProcessRegistration,
  publishProcessIdentity,
  processCompletionPath,
  publishProcessCompletion,
  processIdentityCompleted,
} from "../../../shared/process-registry.ts";
import { signalIdentityTargets } from "../../../shared/process-tree.ts";
import {
  liveTargets,
  type PsRow,
  type Target,
  witnessStep,
} from "./lib/process-witness.ts";

const ROOT = join(process.cwd(), ".context", "foreground-wait");
/** Most log bytes one `wait` relays; older unseen output is summarised. */
const LOG_CAP_BYTES = 256 * 1024;
/** How long a relayed write may make no progress before the relay gives up. */
const STDOUT_STALL_MS = 30_000;
/** Total time one relayed write may take, however steadily it progresses. */
const STDOUT_RELAY_MAX_MS = 60_000;
/**
 * Grace before force termination: POSIX first sends SIGTERM; Windows has no
 * generic cooperative CLI signal and gives the command time to exit. This,
 * `TRACK_POLL_MS` and `WAIT_POLL_MS` take a test pacing seam (`testPacing`).
 */
const KILL_GRACE_MS = testPacing(
  "DRIVE_PR_FOREGROUND_WAIT_KILL_GRACE_MS",
  10_000,
  10,
);
/** One budget covers capture, grace, force and the final witness. */
const CANCEL_BUDGET_MS = testPacing(
  "DRIVE_PR_FOREGROUND_WAIT_CANCEL_MS",
  30_000,
  100,
);
const DEFAULT_DEADLINE_SEC = 5400;
const DEADLINE_ENV = "DRIVE_PR_FOREGROUND_WAIT_TIMEOUT";
/** Most bytes the runner retains in the log; the rest is dropped and said so. */
const LOG_RETAIN_BYTES = 16 * 1024 * 1024;
/** A generation directory this young with no pid recorded is mid-creation. */
const CLAIM_GRACE_MS = 10_000;

interface Result {
  exitCode: number;
  signal: string | null;
  /** Why the runner itself ended the command (deadline, unwritable log). */
  note?: string;
  /** Registry authorities require a boolean; only legacy public results may omit it. */
  treeWitnessed?: boolean;
}

function generations(): number[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT)
    .map((n) => /^gen-(\d+)$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Publish a file by rename, so a reader sees all of it or none of it. */
function writeAtomic(dir: string, name: string, body: string): void {
  const tmp = at(dir, `${name}.tmp`);
  writeFileSync(tmp, `${body}\n`);
  renameSync(tmp, at(dir, name));
}

const genDir = (n: number) => join(ROOT, `gen-${n}`);
const at = (dir: string, name: string) => join(dir, name);

function readPid(dir: string, name: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(at(dir, name), "utf8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The registered authority remains available if a public result copy cannot be written. */
function registeredResultFile(dir: string): string | "unreadable" | null {
  const identity = at(dir, "runner.identity.json");
  if (!existsSync(identity)) return null;
  try {
    const record: unknown = JSON.parse(readFileSync(identity, "utf8"));
    if (!record || typeof record !== "object") return "unreadable";
    if (!("resultFile" in record)) return null;
    return typeof record.resultFile === "string" &&
      isAbsolute(record.resultFile)
      ? record.resultFile
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

function readResult(dir: string): Result | "unreadable" | null {
  let file = at(dir, "result.json");
  const publicResult = existsSync(file);
  if (!publicResult) {
    const authority = registeredResultFile(dir);
    if (authority === "unreadable") return authority;
    if (authority === null || !existsSync(authority)) return null;
    file = authority;
  }
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as Result;
    return Number.isInteger(r.exitCode) &&
      ((publicResult && r.treeWitnessed === undefined) ||
        typeof r.treeWitnessed === "boolean")
      ? r
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

function killZero(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Any live (non-zombie) process at or under the roots `readRoots` returns.
 *
 * The `ps` snapshot is taken BEFORE the pid files are read, never after: the
 * launcher records `runner.pid` and only then exits, so a launcher absent from
 * the snapshot guarantees the runner's pid is already readable. Reading the
 * files first lets the launcher finish in between, leaving roots that name
 * only a dead launcher — a live launch misread as finished.
 *
 * Windows reuses a process number within seconds, so there a root row created
 * after its pid was recorded is another process, and neither it nor its
 * children belong to the launch.
 */
async function liveTree(readRoots: () => RecordedPid[]): Promise<boolean> {
  const rows = await processTable();
  const roots = readRoots();
  // `ps` unavailable: fail toward "still running", as lib/proc.ts does.
  if (rows === null) return roots.some((root) => killZero(root.pid));
  const children = new Map<number, PsRow[]>();
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const stack = [...roots];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const { pid, recordedAt } = stack.pop() as RecordedPid;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row && reusedAfterRecording(row, recordedAt)) continue;
    if (row && !row.stat.startsWith("Z")) return true;
    for (const c of children.get(pid) ?? [])
      stack.push({ pid: c.pid, recordedAt: null });
  }
  return false;
}

/** Slack for coarse file timestamps against the process creation clock. */
const RECORD_CLOCK_SLACK_MS = 2000;

/** A Windows process created after its pid was recorded reused the number. */
function reusedAfterRecording(row: PsRow, recordedAt: number | null): boolean {
  if (process.platform !== "win32" || recordedAt === null) return false;
  const created = Date.parse(row.start);
  return (
    Number.isFinite(created) && created > recordedAt + RECORD_CLOCK_SLACK_MS
  );
}

/** Signal one pid; already-gone or not-ours pids are skipped. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone (ESRCH) or not ours to signal: nothing to terminate.
  }
}

/** Test seam: while this file exists the termination witness reports "still alive". */
const WITNESS_GATE_ENV = "DRIVE_PR_FOREGROUND_WAIT_WITNESS_GATE";
const WITNESS_POLL_MS = 100;
/** How often the runner records the running command's tree. */
const TRACK_POLL_MS = testPacing("DRIVE_PR_FOREGROUND_WAIT_TRACK_MS", 2000, 10);
/** How often `wait` re-checks whether the launch is still running. */
const WAIT_POLL_MS = testPacing("DRIVE_PR_FOREGROUND_WAIT_POLL_MS", 2000, 10);

/** The captured targets still live; empty once every one is witnessed dead. */
async function stillLive(
  targets: Target[],
  rows: PsRow[] | null,
  deadline?: number,
): Promise<Target[]> {
  const live = witnessStep(
    targets,
    rows,
    (pid) => {
      if (process.platform !== "win32") signalPid(pid, "SIGKILL");
    },
    killZero,
  );
  if (process.platform === "win32" && rows !== null) {
    await signalIdentityTargets(
      live,
      "SIGKILL",
      deadline === undefined ? {} : { deadline },
    );
  }
  const gate = process.env[WITNESS_GATE_ENV];
  return gate && existsSync(gate)
    ? targets
    : rows === null
      ? live
      : liveOrUnknownTargets(targets, rows);
}

/** The runner deadline, validated exactly as the other deadlines are; `null` when the variable is unusable. */
function deadlineSec(): number | null {
  const read = readTimeoutEnv(DEADLINE_ENV, DEFAULT_DEADLINE_SEC);
  return read.ok ? read.seconds : null;
}

/** Unwitnessed work retains its evidence and excludes another launch. */
function unresolvedResult(result: Result | "unreadable" | null): boolean {
  return result === "unreadable" || result?.treeWitnessed === false;
}

interface RecordedPid {
  pid: number;
  /** When the pid file was written; null when its time is unreadable. */
  recordedAt: number | null;
}

function recordedPidFiles(dir: string): RecordedPid[] {
  const recorded: RecordedPid[] = [];
  for (const name of ["launcher.pid", "runner.pid", "cmd.pid"]) {
    const pid = readPid(dir, name);
    if (pid === null) continue;
    let recordedAt: number | null = null;
    try {
      recordedAt = statSync(at(dir, name)).mtimeMs;
    } catch {
      // Unreadable time: the pid stays a root, and is never judged reused.
    }
    recorded.push({ pid, recordedAt });
  }
  return recorded;
}

function unrecordedClaimRunning(dir: string): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs < CLAIM_GRACE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The pid records, per generation, that `running` judged not live. */
type SettledRecords = Map<string, RecordedPid[]>;

const sameRecord = (a: RecordedPid, b: RecordedPid): boolean =>
  a.pid === b.pid && a.recordedAt !== null && a.recordedAt === b.recordedAt;

/**
 * Terminal proof is re-read after native enumeration, which may outlive its writer.
 *
 * When the launch reads as not running, the records that verdict covered go
 * into `settled`, so synchronous admission keeps the identity-aware answer
 * rather than re-asking a bare signal probe that a reused number satisfies.
 */
async function running(
  dir: string,
  settled?: SettledRecords,
): Promise<boolean> {
  const result = readResult(dir);
  if (result !== null) return unresolvedResult(result);
  if (readPid(dir, "launcher.pid") === null) return unrecordedClaimRunning(dir);
  const snapshotStarted = Date.now();
  let roots: RecordedPid[] = [];
  const live = await liveTree(() => (roots = recordedPidFiles(dir)));
  const terminal = readResult(dir);
  if (terminal !== null) return unresolvedResult(terminal);
  if (live) return true;
  // A signal probe covers only a pid recorded after the snapshot began. One the
  // snapshot already saw dead stays dead: a later probe can answer only for a
  // process that reused its number.
  const records = recordedPidFiles(dir);
  const probed = (recorded: RecordedPid) =>
    recorded.recordedAt === null ||
    recorded.recordedAt >= snapshotStarted - RECORD_CLOCK_SLACK_MS;
  if (records.some((recorded) => probed(recorded) && killZero(recorded.pid)))
    return true;
  settled?.set(
    dir,
    records.filter(
      (recorded) =>
        probed(recorded) || roots.some((root) => sameRecord(root, recorded)),
    ),
  );
  return false;
}

/**
 * Synchronous final validation: a live writer can still publish unresolved
 * completion. A record `running` already settled is not probed again; a new or
 * rewritten one is.
 */
function blocksAdmission(dir: string, settled: SettledRecords): boolean {
  const result = readResult(dir);
  if (result !== null) return unresolvedResult(result);
  const known = settled.get(dir) ?? [];
  const records = recordedPidFiles(dir);
  return records.length > 0
    ? records.some(
        (recorded) =>
          !known.some((done) => sameRecord(done, recorded)) &&
          killZero(recorded.pid),
      )
    : unrecordedClaimRunning(dir);
}

/** Complete the handoff while the child handle still proves ownership. */
async function recordRunnerIdentity(
  registry: string | undefined,
  entry: string,
  runner: ReturnType<typeof spawn>,
  dir: string,
): Promise<void> {
  if (!registry || runner.pid === undefined) return;
  const authority = processCompletionPath(registry, entry);
  const identity = { pid: runner.pid, start: "", resultFile: authority };
  await handoffProcessRegistration(
    registry,
    entry,
    runner.pid,
    () => processIdentityCompleted(identity),
    () =>
      runner.exitCode === null &&
      runner.signalCode === null &&
      readResult(dir) === null,
    { resultFile: authority },
  );
}

interface StartedRunner {
  runner: ReturnType<typeof spawn>;
  registry: string | undefined;
  entry: string;
}

/** Start and register the supervisor before its launcher returns. */
function startRunner(dir: string, argv: string[], next: number): StartedRunner {
  // A Windows pass cannot rely on a process group after this launcher
  // exits. Publish the runner's creation identity in the pass's registry
  // before returning; the pass can then stop its recorded tree even after
  // Windows has reparented it. A pending registration is unknown, not empty.
  const registry = process.env.JIG_PROCESS_REGISTRY_DIR;
  const entry = `${process.pid}-${next}-${randomUUID()}`;
  if (registry)
    beginProcessRegistration(
      registry,
      entry,
      processCompletionPath(registry, entry),
    );
  const runner = spawn(
    process.execPath,
    [process.argv[1] as string, "_run", dir, entry, "--", ...argv],
    {
      stdio: "ignore",
      cwd: process.cwd(),
      // Bun's Windows subprocess job closes with the launcher. Detachment
      // lets this Bun supervisor survive; its recorded identity keeps it in
      // the pass's cancellation registry. POSIX retains the pass's group.
      detached: process.platform === "win32",
      windowsHide: true,
    },
  );
  runner.unref();
  writeAtomic(dir, "runner.pid", String(runner.pid));
  return { runner, registry, entry };
}

async function anyGenerationRunning(
  gens: number[],
  settled: SettledRecords,
): Promise<boolean> {
  for (const gen of gens) if (await running(genDir(gen), settled)) return true;
  return false;
}

/** The claim is admitted and spawned in one synchronous transaction after all awaits. */
function commitRunnerAdmission(
  dir: string,
  argv: string[],
  next: number,
  settled: SettledRecords,
): StartedRunner | null {
  if (!ownsGenerationLauncher(dir, process.pid)) return null;
  const gens = generations().filter((gen) => genDir(gen) !== dir);
  if (gens.some((gen) => blocksAdmission(genDir(gen), settled))) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  for (const gen of gens) rmSync(genDir(gen), { recursive: true, force: true });
  return startRunner(dir, argv, next);
}

async function launch(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error("foreground-wait: launch needs -- <command> [args...]");
    return 2;
  }
  // Refuse a bad deadline before any work starts, never inside the runner.
  if (deadlineSec() === null) {
    console.error(
      `foreground-wait: ${DEADLINE_ENV}=${JSON.stringify(process.env[DEADLINE_ENV])} is not a usable deadline (digits only, positive, at most 2147483 seconds)`,
    );
    return 2;
  }
  mkdirSync(ROOT, { recursive: true });
  for (;;) {
    const gens = generations();
    const latest = gens.at(-1);
    const settled: SettledRecords = new Map();
    if (await anyGenerationRunning(gens, settled)) {
      console.error(
        "foreground-wait: an earlier launch is still running — call `wait`, never `launch`",
      );
      return 3;
    }
    const next = (latest ?? 0) + 1;
    try {
      mkdirSync(genDir(next)); // the atomic claim
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    const dir = genDir(next);
    if (!claimGenerationLauncher(dir, process.pid)) {
      console.error(
        "foreground-wait: launch claim belongs to another launcher; retained its evidence",
      );
      return 3;
    }
    const started = commitRunnerAdmission(dir, argv, next, settled);
    if (started === null) {
      console.error(
        "foreground-wait: an earlier launch remains unresolved; retained its evidence",
      );
      return 3;
    }
    await recordRunnerIdentity(
      started.registry,
      started.entry,
      started.runner,
      dir,
    );
    console.log(
      `foreground-wait: launched (gen ${next}, runner pid ${started.runner.pid})`,
    );
    return 0;
  }
}

function publish(
  dir: string,
  result: Result,
  registry?: string,
  entry?: string,
): void {
  if (registry && entry) publishProcessCompletion(registry, entry, result);
  writeAtomic(dir, "result.json", JSON.stringify(result));
}

/** Force only this still-owned OS child handle when native identity lookup is unavailable. */
function forceOwnedChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    swallow(
      error,
      "owned foreground command could not be forced; tree remains unknown",
    );
  }
}

/** A readable runner identity can finish a handoff whose launch-time probe failed. */
function registerRunnerSnapshot(
  registry: string | undefined,
  entry: string | undefined,
  rows: ProcessRow[] | null,
): boolean {
  if (!registry || !entry) return false;
  const self = rows?.find((row) => row.pid === process.pid);
  if (!self?.start) return false;
  publishProcessIdentity(
    registry,
    entry,
    self,
    processCompletionPath(registry, entry),
  );
  return true;
}

/** A test fixture can establish captured identities before starting its unchanged deadline. */
function armCommandDeadline(
  seconds: number,
  timers: NodeJS.Timeout[],
  terminate: (code: number, note: string) => Promise<void>,
): void {
  const start = () =>
    timers.push(
      setTimeout(() => {
        void terminate(124, `deadline of ${seconds}s reached`);
      }, seconds * 1000),
    );
  const gate =
    process.env.NODE_ENV === "test"
      ? process.env.DRIVE_PR_FOREGROUND_WAIT_DEADLINE_GATE
      : undefined;
  if (!gate) {
    start();
    return;
  }
  const readyBy = Date.now() + 20000;
  const readiness = setInterval(() => {
    if (!existsSync(gate) && Date.now() < readyBy) return;
    clearInterval(readiness);
    if (existsSync(gate)) start();
    else void terminate(125, "test deadline gate did not become ready");
  }, 20);
  timers.push(readiness);
}

/** Test-only acknowledgment of identities already bound by the runner's tracker. */
function acknowledgeCapture(
  tree: ForegroundTreeState,
  rows: PsRow[] | null,
): void {
  const marker = process.env.DRIVE_PR_FOREGROUND_WAIT_CAPTURE_ACK;
  if (process.env.NODE_ENV === "test" && marker && rows !== null)
    writeFileSync(
      marker,
      JSON.stringify({
        root: tree.root,
        targets: liveTargets(tree.targets, rows),
      }),
    );
}

/** Bind the stable supervisor before any user command is allowed to execute. */
async function bindRunner(): Promise<{
  root: Target;
  rows: Awaited<ReturnType<typeof processTable>>;
} | null> {
  const deadline = Date.now() + CANCEL_BUDGET_MS;
  while (Date.now() < deadline) {
    const rows = await processTable(
      Math.max(0.001, Math.min(5, (deadline - Date.now()) / 1000)),
    );
    const own = rows?.find(
      (row) =>
        row.pid === process.pid && row.start && !row.stat.startsWith("Z"),
    );
    if (own) return { root: { pid: own.pid, start: own.start }, rows };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))),
    );
  }
  return null;
}

async function run(
  dir: string,
  argv: string[],
  entry: string | undefined,
): Promise<void> {
  const registry = process.env.JIG_PROCESS_REGISTRY_DIR;
  let registered = false;
  const log = at(dir, "log");
  const bound = await bindRunner();
  if (bound === null) {
    const note =
      "could not establish supervisor ownership; command was not started";
    appendFileSync(log, `foreground-wait: ${note}\n`);
    publish(
      dir,
      { exitCode: 125, signal: null, treeWitnessed: true, note },
      registry,
      entry,
    );
    if (registry && entry) clearPendingProcessRegistration(registry, entry);
    return;
  }
  writeAtomic(
    dir,
    "runner.identity.json",
    JSON.stringify({
      ...bound.root,
      ...(registry && entry
        ? { resultFile: processCompletionPath(registry, entry) }
        : {}),
    }),
  );
  registered = registerRunnerSnapshot(registry, entry, bound.rows);
  // Output passes through the runner so retention is bounded at the writer.
  const child = spawn(argv[0] as string, argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let retained = 0;
  let truncated = false;
  let settled = false;
  // Why the runner is ending the command itself; `null` while it runs free.
  let termination: {
    exitCode: number;
    signal: string | null;
    note: string;
  } | null = null;
  // Captured BEFORE the first signal: once the command dies, its surviving
  // descendants are re-parented and a fresh snapshot no longer reaches them.
  const tree: ForegroundTreeState = {
    root: bound.root,
    targets: [],
    unknown: new Set(),
    unresolved: false,
    unverifiable: false,
  };
  let lastRows: PsRow[] | null = bound.rows;
  let cancellationDeadline: number | undefined;
  const snapshot = () =>
    processTable(
      cancellationDeadline === undefined
        ? 5
        : Math.max(
            0.001,
            Math.min(5, (cancellationDeadline - Date.now()) / 1000),
          ),
    );

  let witnessing = false;
  // Tracking and signalling are separate duties. `track` only maintains
  // `tree.targets` — every identity observed under the command, minus those verified
  // dead, so it stays bounded by what is live. Signalling is `terminate`'s job
  // and reaches every live tracked identity, not just newly observed ones.
  // Once the witness owns `tree.targets` (it shrinks it as targets are seen dead),
  // the periodic tracker stands down; only an explicit recapture runs.
  let tracking: Promise<void> = Promise.resolve();
  let pendingTracks = 0;
  const track = (recapture = false): Promise<void> => {
    // A slow native enumeration must not accumulate a backlog of periodic
    // reads ahead of the deadline's capture. Coalesce tracking while busy.
    if (!recapture && pendingTracks > 0) return tracking;
    pendingTracks++;
    tracking = tracking
      .then(async () => {
        if (child.pid === undefined || (witnessing && !recapture)) return;
        const rows = await snapshot();
        if (settled) return;
        if (!registered)
          registered = registerRunnerSnapshot(registry, entry, rows);
        lastRows = rows;
        trackForegroundAnchor(rows, tree);
        acknowledgeCapture(tree, rows);
      })
      .finally(() => {
        pendingTracks--;
      });
    return tracking;
  };
  const capture = () => track(true);
  // Every tracked identity gets one grace interval before force. POSIX first
  // sends SIGTERM; Windows starts the interval without a cooperative signal.
  // An identity recovered after an unreadable snapshot gets its own full grace.
  const graceStarted = new Map<string, number>();
  const idOf = (t: Target) => `${t.pid}:${t.start}`;
  const beginGrace = () => {
    for (const t of lastRows === null
      ? []
      : liveTargets(tree.targets, lastRows)) {
      if (graceStarted.has(idOf(t))) continue;
      // Windows has no cooperative POSIX TERM: retain the identity and let
      // the witness force termination after the grace.
      if (process.platform !== "win32") signalPid(t.pid, "SIGTERM");
      graceStarted.set(idOf(t), Date.now());
    }
  };
  const timers: NodeJS.Timeout[] = [];
  const settle = (result: Result) => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    try {
      // A terminal report can explicitly retain uncertainty about descendants.
      // Reinstate the pending boundary before publishing that report, even if
      // this runner's own identity was recorded earlier.
      if (registry && entry && result.treeWitnessed !== true)
        beginProcessRegistration(
          registry,
          entry,
          processCompletionPath(registry, entry),
        );
      publish(dir, result, registry, entry);
      if (registry && entry && result.treeWitnessed === true)
        clearPendingProcessRegistration(registry, entry);
    } catch {
      // The result cannot be written (disk full): `wait` then reports the
      // launch lost (exit 21) once nothing is alive, rather than hanging.
    }
  };
  const armCancellationBudget = (result: Result) => {
    if (cancellationDeadline !== undefined) return;
    cancellationDeadline = Date.now() + CANCEL_BUDGET_MS;
    timers.push(
      setTimeout(() => {
        const reason = termination ?? result;
        forceOwnedChild(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settle({
          ...reason,
          treeWitnessed: false,
          note: `${reason.note ? `${reason.note}; ` : ""}process-tree cancellation could not be witnessed within its budget; descendants may survive`,
        });
      }, CANCEL_BUDGET_MS),
    );
  };
  // A verified result requires the captured targets to be witnessed dead.
  // Unreadable snapshots withhold verified publication. If the complete tree could not
  // be captured, a later report retains treeWitnessed:false and says so.
  const forceUnresolvedOwnedChild = () => {
    if (process.platform !== "win32" || !tree.unresolved) return;
    // A handle can safely end our command while CIM is unavailable, but cannot
    // establish what its unobserved descendants did during that outage.
    tree.unverifiable = true;
    forceOwnedChild(child);
  };
  const settleWhenTerminated = (result: Result) => {
    if (settled || witnessing) return;
    witnessing = true;
    let polling = false;
    const poll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        // Finish any earlier tracker query before enumerating the anchored
        // workload; a concurrent observer must never become a target.
        await tracking;
        if (settled) return;
        const rows = await snapshot();
        if (settled) return;
        lastRows = rows;
        trackForegroundAnchor(rows, tree);
        forceUnresolvedOwnedChild();
        beginGrace();
        const now = Date.now();
        const due = tree.targets.filter(
          (t) => now - (graceStarted.get(idOf(t)) ?? now) >= KILL_GRACE_MS,
        );
        const waiting = tree.targets.filter((t) => !due.includes(t));
        tree.targets = [
          ...(await stillLive(due, rows, cancellationDeadline)),
          ...(rows === null ? waiting : liveOrUnknownTargets(waiting, rows)),
        ];
        const witnessGate = process.env[WITNESS_GATE_ENV];
        if (
          tree.unresolved ||
          rows === null ||
          tree.targets.length > 0 ||
          (witnessGate && existsSync(witnessGate))
        )
          return;
        clearInterval(poll);
        settle(
          tree.unverifiable
            ? {
                ...result,
                treeWitnessed: false,
                note: `${result.note ? `${result.note}; ` : ""}the command's complete process tree could not be witnessed, so descendants may survive`,
              }
            : { ...result, treeWitnessed: true },
        );
      } finally {
        polling = false;
      }
    }, WITNESS_POLL_MS);
    timers.push(poll as unknown as NodeJS.Timeout);
  };
  // Deadline and log failure share the same grace and owned-child fallback.
  // Closing pipes lets the runner keep checking tree identities even when an
  // unobserved descendant inherited those pipes and outlived its parent.
  const terminate = async (
    exitCode: number,
    note: string,
    signal: string | null = null,
  ) => {
    if (termination !== null || settled) return;
    termination = { exitCode, signal, note };
    armCancellationBudget({ exitCode, signal, note });
    try {
      appendFileSync(
        log,
        `foreground-wait: ${note}; terminating the command tree\n`,
      );
    } catch {
      // Best effort: the result's `note` still carries the reason.
    }
    await capture();
    if (settled) return;
    // Begin grace for every verified tracked identity. POSIX sends SIGTERM;
    // Windows allows the same interval before identity-checked force.
    beginGrace();
    // On POSIX, an unreadable capture still allows TERM of our unreaped child.
    // Windows uses the child handle to force it after the grace below.
    if (
      process.platform !== "win32" &&
      tree.unresolved &&
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      signalPid(child.pid, "SIGTERM");
    }
    timers.push(
      setTimeout(() => {
        forceUnresolvedOwnedChild();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settleWhenTerminated({ exitCode, signal, note });
      }, KILL_GRACE_MS),
    );
  };
  const write = (data: string | Uint8Array) => {
    try {
      appendFileSync(log, data);
      return true;
    } catch (err) {
      void terminate(
        125,
        `could not write the log (${(err as Error).message})`,
      );
      return false;
    }
  };
  const retain = (chunk: Buffer) => {
    if (truncated || termination !== null) return;
    const room = LOG_RETAIN_BYTES - retained;
    if (chunk.length <= room) {
      if (write(chunk)) retained += chunk.length;
      return;
    }
    truncated = true;
    if (!write(chunk.subarray(0, room))) return;
    write(
      `\nforeground-wait: output exceeded ${LOG_RETAIN_BYTES} bytes; the rest is dropped\n`,
    );
  };
  child.stdout?.on("data", retain);
  child.stderr?.on("data", retain);
  if (child.pid !== undefined) writeAtomic(dir, "cmd.pid", String(child.pid));
  // Track the tree while the command runs (no signalling), so a `ps` failure at
  // termination time still leaves the descendants known and the command's
  // identity recorded.
  void track();
  timers.push(
    setInterval(() => {
      void track();
    }, TRACK_POLL_MS) as unknown as NodeJS.Timeout,
  );
  const seconds = deadlineSec() ?? DEFAULT_DEADLINE_SEC;
  armCommandDeadline(seconds, timers, terminate);
  // `close` follows `error` for a failed spawn; the first outcome wins.
  child.on("error", (err) => {
    write(`foreground-wait: could not start command: ${err.message}\n`);
    settle({
      exitCode: 127,
      signal: null,
      treeWitnessed: child.pid === undefined,
    });
  });
  child.on("close", async (code, signal) => {
    if (settled) return;
    // The command can exit on SIGTERM while a descendant ignores it, and
    // settling clears the scheduled SIGKILL — so finish the kill here, on the
    // targets captured before signalling, before a terminal result exists.
    if (termination !== null) {
      settleWhenTerminated({
        exitCode: termination.exitCode,
        signal: termination.signal,
        note: termination.note,
      });
      return;
    }
    const exitCode = code ?? (signal ? 128 : 1);
    armCancellationBudget({ exitCode, signal: signal ?? null });
    // Command exit alone is not tree proof. End any descendants the tracker
    // observed through the same grace and witness path, retaining uncertainty
    // when the complete tree could not be captured.
    await capture();
    if (tree.targets.length > 0 || tree.unresolved) {
      void terminate(
        exitCode,
        "the command exited with descendants still running; terminated them",
        signal ?? null,
      );
      return;
    }
    settle({
      exitCode,
      signal: signal ?? null,
      treeWitnessed: !tree.unverifiable && !tree.unresolved,
    });
  });
}

/** Relay the log bytes not yet shown, bounded, advancing a per-launch cursor. */
function relayLog(dir: string): void {
  if (!existsSync(at(dir, "log"))) return;
  const size = statSync(at(dir, "log")).size;
  const seen = Number.parseInt(
    existsSync(at(dir, "log.cursor"))
      ? readFileSync(at(dir, "log.cursor"), "utf8")
      : "0",
    10,
  );
  let start = Number.isInteger(seen) && seen >= 0 && seen <= size ? seen : 0;
  if (size - start > LOG_CAP_BYTES) {
    const omitted = size - LOG_CAP_BYTES - start;
    console.log(`[foreground-wait: ${omitted} earlier log bytes omitted]`);
    start = size - LOG_CAP_BYTES;
  }
  const buf = Buffer.alloc(size - start);
  const fd = openSync(at(dir, "log"), "r");
  let got = 0;
  try {
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  writeStdoutSync(buf.subarray(0, got));
  writeFileSync(at(dir, "log.cursor"), `${start + got}\n`);
}

/**
 * Write all of `bytes` to stdout before returning. `process.stdout.write` on a
 * pipe is asynchronous under Bun: the `console.log` lines that follow overtook
 * its tail, and `process.exit` then dropped whatever had not drained — on Linux
 * under load, the relayed tail including the truncation marker.
 */
function writeStdoutSync(bytes: Uint8Array): void {
  let off = 0;
  const startedAt = Date.now();
  let lastProgress = startedAt;
  while (off < bytes.length) {
    try {
      const n = writeSync(1, bytes, off, bytes.length - off);
      off += n;
      if (n > 0) lastProgress = Date.now();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      // A non-blocking stdout whose reader is behind: back off and retry. The
      // sleep blocks the event loop, so the stall is bounded here — a reader
      // that stays open but stops draining must fail the relay, not wedge it
      // past the wait budget with the cancellation handlers unable to run.
      if (Date.now() - lastProgress > STDOUT_STALL_MS) {
        throw new Error(
          `foreground-wait: stdout reader made no progress for ${STDOUT_STALL_MS}ms`,
          { cause: err },
        );
      }
      // Slow-but-steady progress resets the stall clock, so the relay also has
      // an overall budget: a reader taking a few KiB per interval must not
      // keep this synchronous loop running past the caller's wait budget.
      if (Date.now() - startedAt > STDOUT_RELAY_MAX_MS) {
        throw new Error(
          `foreground-wait: stdout relay exceeded ${STDOUT_RELAY_MAX_MS}ms`,
          { cause: err },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/** Relay the rest of the log and report a published result. */
function finish(dir: string, result: Result | "unreadable"): number {
  relayLog(dir);
  if (result === "unreadable") {
    console.log("foreground-wait: result file unreadable");
    return 30;
  }
  if (result.note) console.log(`foreground-wait: ${result.note}`);
  if (result.treeWitnessed === false)
    console.log(
      "foreground-wait: process tree remains unverified; new launches are blocked",
    );
  console.log(
    `command-exit: ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}`,
  );
  return result.exitCode === 0 && result.treeWitnessed !== false ? 0 : 30;
}

async function wait(maxSec: number): Promise<number> {
  const latest = generations().at(-1);
  if (latest === undefined) {
    console.error("foreground-wait: no launch on record");
    return 2;
  }
  const dir = genDir(latest);
  const deadline = Date.now() + maxSec * 1000;
  while (
    readResult(dir) === null &&
    (await running(dir)) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
  // Result first, then the log: a published result means the log is complete.
  const result = readResult(dir);
  if (result !== null) return finish(dir, result);
  if (await running(dir)) {
    relayLog(dir);
    console.log("still running — call `wait` again (never `launch`)");
    return 20;
  }
  // A result can land between the read above and `running` seeing it: re-read
  // once the launch is observed not running, before calling it lost.
  const late = readResult(dir);
  if (late !== null) return finish(dir, late);
  relayLog(dir);
  console.log("no recorded process is alive and no result was published");
  return 21;
}

const [cmd, ...rest] = process.argv.slice(2);
const sep = rest.indexOf("--");
const after = sep === -1 ? [] : rest.slice(sep + 1);

if (cmd === "launch") {
  process.exit(await launch(after));
} else if (cmd === "_run") {
  await run(rest[0] as string, after, rest[1]);
} else if (cmd === "wait") {
  const i = rest.indexOf("--max-sec");
  const n = i === -1 ? 540 : Number.parseInt(rest[i + 1] ?? "", 10);
  process.exit(await wait(Number.isInteger(n) && n > 0 ? n : 540));
} else {
  console.error(
    "usage: foreground-wait.ts launch -- <cmd…> | wait [--max-sec N]",
  );
  process.exit(2);
}
