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
 * 30 finished with the command failing (the `command-exit:` line carries its
 * status and signal); 20 still running — call `wait` again, never `launch`;
 * 21 nothing of the launch is alive and no result was published; 2 usage / no
 * launch on record. `launch` exits 3 while an earlier launch is running, so a
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
  trackForegroundProcessTree,
  type ForegroundTreeState,
} from "./lib/foreground-process-tree.ts";
import { liveOrUnknownTargets } from "../../../shared/process-uncertainty.ts";
import { spawn } from "node:child_process";
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
import { join } from "node:path";
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
  /** Explicit completion proof for registry reconciliation; legacy or unknown is false. */
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

function readResult(dir: string): Result | "unreadable" | null {
  if (!existsSync(at(dir, "result.json"))) return null;
  try {
    const r = JSON.parse(
      readFileSync(at(dir, "result.json"), "utf8"),
    ) as Result;
    return Number.isInteger(r.exitCode) ? r : "unreadable";
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
 */
async function liveTree(readRoots: () => number[]): Promise<boolean> {
  const rows = await processTable();
  const roots = readRoots();
  // `ps` unavailable: fail toward "still running", as lib/proc.ts does.
  if (rows === null) return roots.some(killZero);
  const children = new Map<number, PsRow[]>();
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const stack = [...roots];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row && !row.stat.startsWith("Z")) return true;
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return false;
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
    await signalIdentityTargets(live, "SIGKILL");
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

async function running(dir: string): Promise<boolean> {
  if (readResult(dir) !== null) return false;
  if (readPid(dir, "launcher.pid") === null) {
    // Claimed but nothing recorded yet: mid-creation, unless the creator died.
    try {
      return Date.now() - statSync(dir).mtimeMs < CLAIM_GRACE_MS;
    } catch (err) {
      // Removed by a newer launch: superseded, not running.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
  return liveTree(() =>
    ["launcher.pid", "runner.pid", "cmd.pid"]
      .map((n) => readPid(dir, n))
      .filter((p): p is number => p !== null),
  );
}

/** Complete the handoff while the child handle still proves ownership. */
async function recordRunnerIdentity(
  registry: string | undefined,
  entry: string,
  runner: ReturnType<typeof spawn>,
  dir: string,
): Promise<void> {
  if (!registry || runner.pid === undefined) return;
  await handoffProcessRegistration(
    registry,
    entry,
    runner.pid,
    () => {
      const result = readResult(dir);
      return (
        result !== null &&
        result !== "unreadable" &&
        result.treeWitnessed === true
      );
    },
    () =>
      runner.exitCode === null &&
      runner.signalCode === null &&
      readResult(dir) === null,
    { resultFile: at(dir, "result.json") },
  );
}

/** Start and register the supervisor before its launcher returns. */
async function startRunner(
  dir: string,
  argv: string[],
  next: number,
): Promise<void> {
  // A Windows pass cannot rely on a process group after this launcher
  // exits. Publish the runner's creation identity in the pass's registry
  // before returning; the pass can then stop its recorded tree even after
  // Windows has reparented it. A pending registration is unknown, not empty.
  const registry = process.env.JIG_PROCESS_REGISTRY_DIR;
  const entry = `${process.pid}-${next}`;
  if (registry)
    beginProcessRegistration(registry, entry, at(dir, "result.json"));
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
  await recordRunnerIdentity(registry, entry, runner, dir);
  console.log(
    `foreground-wait: launched (gen ${next}, runner pid ${runner.pid})`,
  );
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
    if (latest !== undefined && (await running(genDir(latest)))) {
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
    writeAtomic(dir, "launcher.pid", String(process.pid));
    for (const old of gens)
      rmSync(genDir(old), { recursive: true, force: true });
    await startRunner(dir, argv, next);
    return 0;
  }
}

function publish(dir: string, result: Result): void {
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
  resultFile: string,
): boolean {
  if (!registry || !entry) return false;
  const self = rows?.find((row) => row.pid === process.pid);
  if (!self?.start) return false;
  publishProcessIdentity(registry, entry, self, resultFile);
  return true;
}

function run(dir: string, argv: string[], entry: string | undefined): void {
  const registry = process.env.JIG_PROCESS_REGISTRY_DIR;
  let registered = false;
  const log = at(dir, "log");
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
    root: null,
    targets: [],
    unknown: new Set(),
    unresolved: false,
    unverifiable: false,
  };
  let lastRows: PsRow[] | null = null;
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
        const rows = await processTable();
        if (settled) return;
        if (!registered)
          registered = registerRunnerSnapshot(
            registry,
            entry,
            rows,
            at(dir, "result.json"),
          );
        lastRows = rows;
        trackForegroundProcessTree(
          child.pid,
          child.exitCode !== null || child.signalCode !== null,
          rows,
          tree,
        );
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
        beginProcessRegistration(registry, entry, at(dir, "result.json"));
      publish(dir, result);
      if (registry && entry && result.treeWitnessed === true)
        clearPendingProcessRegistration(registry, entry);
    } catch {
      // The result cannot be written (disk full): `wait` then reports the
      // launch lost (exit 21) once nothing is alive, rather than hanging.
    }
  };
  // A verified result requires the captured targets to be witnessed dead.
  // Unreadable snapshots withhold publication. If the complete tree could not
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
        const rows = await processTable();
        lastRows = rows;
        if (child.pid !== undefined)
          trackForegroundProcessTree(
            child.pid,
            child.exitCode !== null || child.signalCode !== null,
            rows,
            tree,
          );
        forceUnresolvedOwnedChild();
        beginGrace();
        const now = Date.now();
        const due = tree.targets.filter(
          (t) => now - (graceStarted.get(idOf(t)) ?? now) >= KILL_GRACE_MS,
        );
        const waiting = tree.targets.filter((t) => !due.includes(t));
        tree.targets = [
          ...(await stillLive(due, rows)),
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
    try {
      appendFileSync(
        log,
        `foreground-wait: ${note}; terminating the command tree\n`,
      );
    } catch {
      // Best effort: the result's `note` still carries the reason.
    }
    await capture();
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
  timers.push(
    setTimeout(() => {
      void terminate(124, `deadline of ${seconds}s reached`);
    }, seconds * 1000),
  );
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
    return 1;
  }
  if (result.note) console.log(`foreground-wait: ${result.note}`);
  console.log(
    `command-exit: ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}`,
  );
  return result.exitCode === 0 ? 0 : 30;
}

async function wait(maxSec: number): Promise<number> {
  const latest = generations().at(-1);
  if (latest === undefined) {
    console.error("foreground-wait: no launch on record");
    return 2;
  }
  const dir = genDir(latest);
  const deadline = Date.now() + maxSec * 1000;
  while ((await running(dir)) && Date.now() < deadline) {
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
  run(rest[0] as string, after, rest[1]);
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
