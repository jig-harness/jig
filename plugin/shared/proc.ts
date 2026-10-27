import { armProcessDeadline } from "./process-deadline.ts";
import { spawnCommand } from "./windows-command.ts";
export {
  lastBytes,
  MAX_BUFFER_BYTES,
  STDERR_TAIL_BYTES,
} from "./process-output.ts";
import {
  captureProcessOutput,
  lastBytes,
  type ProcessTimers,
} from "./process-output.ts";
import { windowsProcessLifecycle } from "./windows-process.ts";
import { stopWindowsTree } from "./process-tree.ts";
import { registerSignalHandler, shutdownRequested } from "./cleanup.ts";
/**
 * Process spawning with deadlines — the TypeScript successor to
 * `lib/gh-deadline.sh`, and the place every skill's `gh` is spawned from.
 *
 * Bound every outbound `gh` call. `gh` has no timeout of its own, and none of
 * the scripts can supply one from their poll loops: a deadline is only
 * ever consulted BETWEEN calls, so an accepted-but-never-completed connection
 * parks the driver past every advertised deadline — mode 13 in drive-pr's
 * references/terminal-states.md.
 *
 * The bash version leaned on coreutils `timeout` with a `perl -e alarm`
 * fallback, because a shell cannot kill a child it is blocked reading from.
 * A JS runtime can: the deadline is a timer in the SAME process that spawned
 * the child, so there is no watchdog to outlive the script and no PID-reuse
 * hazard (the measured failure that ruled out the background-and-kill shell
 * pattern) — and no dependency on either external binary, which is
 * what makes this port run on Windows at all.
 *
 * Distributed independently of consumer drivers. Drivers with richer process
 * APIs share cancellation ownership through `registerCancellationGroup`.
 * Bundled entry points share one process-wide registry so importing multiple
 * helpers never installs competing forwarders.
 *
 * Callers may pre-set GH_CALL_TIMEOUT; it is honoured, not overwritten — but
 * only when it is a positive whole number of seconds. GNU `timeout 0` disables
 * the timeout outright rather than firing immediately, and the bash lib
 * refused `0` for exactly that reason; the refusal is kept even though a JS
 * timer would technically fire, because a caller writing `0` is asking for an
 * unbounded call whichever implementation they get, and that is the exact
 * failure mode this file exists to prevent. A non-numeric or non-positive
 * value is a caller mistake, not a configuration to tolerate, so it is
 * rejected rather than quietly floored.
 */

import type { SpawnOptions } from "node:child_process";
import { traceEnv, traceGhRunner, traceRunner } from "./trace.ts";
import { fail } from "./cli.ts";
import { errnoCode } from "./errors.ts";

/**
 * Validate a timeout environment variable the way `gh-deadline.sh` did: unset
 * or EMPTY falls back to the default (bash `${VAR:-30}` substitutes on empty
 * too), anything non-numeric refuses, and an all-zero spelling ('0', '00', …)
 * refuses as well — digits-only is not yet positive, and `00` disables a GNU
 * timeout exactly like `0` does, just under a different literal.
 *
 * Returns the resolved seconds, or the offending raw value when the caller
 * must refuse (each caller owns its own message and exit code).
 */
export function readTimeoutEnv(
  name: string,
  def: number,
): { ok: true; seconds: number } | { ok: false; raw: string } {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return { ok: true, seconds: def };
  if (!/^[0-9]+$/.test(raw) || /^0+$/.test(raw)) return { ok: false, raw };
  const seconds = Number.parseInt(raw, 10);
  // Digits-only and positive is still not a usable deadline. `setTimeout`
  // takes a 32-bit signed delay in MILLISECONDS: anything over 2147483647ms
  // (~24.8 days) overflows and fires IMMEDIATELY, so a caller asking for an
  // enormous timeout would silently get an instant one — the deadline
  // inverted rather than relaxed, on the one knob whose whole job is to be
  // generous. A value that cannot be
  // represented is a caller mistake like the others here, so it is refused
  // rather than clamped: clamping would honour a request nobody made.
  if (!Number.isSafeInteger(seconds) || seconds * 1000 > 2_147_483_647) {
    return { ok: false, raw };
  }
  return { ok: true, seconds };
}

/**
 * GH_CALL_TIMEOUT with `gh-deadline.sh`'s own refusal semantics (exit 1).
 * Evaluated per call so an entry script that validates the variable itself
 * with a different exit code can run its check first.
 */
export function ghCallTimeoutSeconds(): number {
  const read = readTimeoutEnv("GH_CALL_TIMEOUT", 30);
  if (read.ok) return read.seconds;
  if (/^0+$/.test(read.raw)) {
    fail(
      1,
      "gh-deadline: GH_CALL_TIMEOUT=0 disables the deadline instead of firing immediately — refusing",
    );
  }
  fail(
    1,
    `gh-deadline: GH_CALL_TIMEOUT must be a positive whole number of seconds no`,
    `greater than 2147483 (got '${read.raw}') — beyond that the millisecond delay`,
    "overflows a 32-bit timer and fires immediately, inverting the deadline.",
  );
}

export interface RunResult {
  /** The child's exit code; 124 when the deadline killed it (GNU timeout's code). */
  code: number;
  /** The terminating signal when the runtime reports one; absent for a numeric exit. */
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** `true` when captured stdout+stderr hit `maxBufferBytes` and the child was killed for it. */
  bufferExceeded: boolean;
  /**
   * `true` when NO CHILD EVER RAN — the binary was not on `PATH`, the path did
   * not resolve, `spawn` itself refused the arguments.
   *
   * `code` alone cannot answer this and must not be used to. A failed
   * spawn reports 127, the shell's code for a command that could not be
   * found (see `run`'s header), but 127 is
   * also an exit code a REAL child may legitimately return — a shell wrapper
   * whose own inner command was missing being the obvious case. The two are
   * opposite facts about whether anything happened, and a caller that has to
   * know cannot recover the difference downstream.
   *
   * `converge.ts` is that caller: it releases `/drive-pr`'s tier-3 lease only
   * when a pass ACTUALLY RAN and could therefore hold a claim. Keyed on
   * `code !== 0` instead, a `codex` binary missing from `PATH` — the first run
   * on a fresh machine — released a record this invocation never took, which
   * strips a live sibling resolver's protection and admits another worktree.
   * Reported as a separate field rather than folded into `code` so no existing
   * caller's exit-status reading changes.
   */
  spawnFailed: boolean;
  /**
   * The last `STDERR_TAIL_BYTES` of the child's error output when it failed
   * (any non-zero `code`), and `""` when it succeeded. Kept past the
   * `maxBufferBytes` cap, so a child killed for its output still says why.
   * Empty under `stderr: "inherit"` (the output went to this process's own
   * error stream) and `stderr: "ignore"` (it went nowhere).
   */
  stderrTail: string;
  /**
   * `true` when `reapGroup` was asked for and the child exited leaving
   * members of its process group alive; they were killed.
   */
  groupSurvived?: boolean;
}

/**
 * Programs whose second word is a subcommand. For any other program the
 * second word can be anything (a URL with a credential in it, a path), so
 * only the program is named.
 */
const SUBCOMMAND_PROGRAMS = new Set(["gh", "git"]);

/**
 * A child that failed, as an error: the command (the program, and its second
 * word when the program is one of `SUBCOMMAND_PROGRAMS` and that word is a
 * plain subcommand name; never the other arguments' contents), its exit code
 * and the tail of its error output.
 * Pass it as the `cause` of the error a caller throws (`failFrom` in
 * `cli.ts`), so the command-line boundary shows it under `JIG_LOG=debug`.
 */
export class ChildFailure extends Error {
  readonly command: string;
  readonly code: number;
  readonly stderrTail: string;
  constructor(argv: readonly string[], result: RunResult) {
    const [program = "", next] = argv;
    const name = program.split(/[\\/]/).pop() ?? "";
    const command =
      next !== undefined &&
      SUBCOMMAND_PROGRAMS.has(name) &&
      /^[a-z][a-z0-9-]*$/.test(next)
        ? `${program} ${next}`
        : program;
    const how = result.spawnFailed
      ? "could not start"
      : result.timedOut
        ? "was killed at its deadline"
        : result.bufferExceeded
          ? "was killed for too much output"
          : `exited ${result.code}`;
    super(`${command} ${how}`);
    this.name = "ChildFailure";
    this.command = command;
    this.code = result.code;
    this.stderrTail = result.stderrTail;
  }
}

/** A child may exit before consuming input; its own status owns that result. */
export function writeChildInput(
  input: import("node:stream").Writable | null,
  text: string | undefined,
): void {
  if (text === undefined || input === null) return;
  input.on("error", () => {
    // EPIPE after early exit does not replace the child's own result.
  });
  input.end(text);
}

export interface RunOptions {
  /** Seconds before the child is killed. Omit for no deadline. */
  timeoutSec?: number;
  /** Text written to the child's stdin (the pipe closes after it). */
  stdin?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Where the child's stderr goes. 'pipe' captures it into the result (the
   * default), 'inherit' passes it through to this process's stderr — the
   * bash equivalent of NOT writing `2>/dev/null` — and 'ignore' attaches the
   * null device, which is exactly what a `2>/dev/null` child saw.
   */
  stderr?: "pipe" | "inherit" | "ignore";
  /** 'inherit' streams output through (converge.ts's pass command). */
  stdout?: "pipe" | "inherit" | "ignore";
  /** 'inherit' hands the child this process's stdin (the pass command again). */
  stdinInherit?: boolean;
  /**
   * Called with each captured chunk of output as it arrives, so a caller can
   * keep both streams in the order the child wrote them; output past the
   * buffer cap is not passed on.
   */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /** Overrides `MAX_BUFFER_BYTES` — a test knob, not a per-caller tuning lever. */
  maxBufferBytes?: number;
  /**
   * When the child exits, kill whatever is still alive in its process group
   * and report it as `groupSurvived`: for a command whose work must be over
   * when it returns, so a background job it left cannot write afterwards.
   * On POSIX this requires `timeoutSec`, which gives the child its own
   * group; a descendant that left the group (`setsid`) is not reached.
   * On Windows this reaps the registered foreground runners.
   */
  reapGroup?: boolean;
  /**
   * Test-only: fires once per stdout/stderr chunk with whether it was
   * captured or discarded past the buffer cap. Lets a test assert directly
   * that later chunks are excluded, rather than inferring it from a captured
   * byte count a real OS pipe's chunking makes an unreliable proxy.
   */
  onChunk?: (
    stream: "stdout" | "stderr",
    bytes: number,
    captured: boolean,
  ) => void;
}

/**
 * Live children a signal aimed at THIS process can never reach, keyed by the
 * process group each one leads.
 *
 * A deadlined child is detached (see `run`), which is what lets the deadline
 * kill the whole tree — and, by exactly the same token, what stops a signal
 * delivered to this process, or to its group, from reaching it. Nothing else
 * forwards one, so terminating the script leaves the `gh` call running to
 * completion: `reply-to-thread`'s GraphQL mutation lands after the operator
 * believes the operation was cancelled (first seen against the bash
 * `gh-deadline.sh` and reproduced unchanged against this port — the subshell
 * involved there is gone, the isolated group it was compounded by is not).
 */
interface CancellationRegistry {
  handlerRegistered: boolean;
  groups: Map<number, Set<symbol>>;
  registryDirs: Map<number, string>;
  cancelWindows: Map<number, () => Promise<boolean>>;
  inflight?: Promise<boolean>;
}
const registryKey = Symbol.for("jig.review.process-cancellation.v1");
const globalRegistry = globalThis as typeof globalThis & {
  [key: symbol]: CancellationRegistry | undefined;
};
const cancellation = globalRegistry[registryKey] ?? {
  handlerRegistered: false,
  groups: new Map<number, Set<symbol>>(),
  registryDirs: new Map<number, string>(),
  cancelWindows: new Map<number, () => Promise<boolean>>(),
};
globalRegistry[registryKey] = cancellation;
const cancellableGroups = cancellation.groups;

/** Whether any process is left in the group `pgid` leads. */
function groupAlive(pgid: number | undefined): boolean {
  if (pgid === undefined) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: a member exists that this process may not signal.
    return errnoCode(error) === "EPERM";
  }
}

/** Share cancellation ownership with consumer runners; release on settlement. */
export function registerCancellationGroup(
  pgid: number,
  registryDir?: string,
  cancelWindows?: () => Promise<boolean>,
): () => void {
  if (cancelWindows) cancellation.cancelWindows.set(pgid, cancelWindows);
  if (registryDir) cancellation.registryDirs.set(pgid, registryDir);
  const token = Symbol();
  let registrations = cancellableGroups.get(pgid);
  if (!registrations) {
    registrations = new Set<symbol>();
    cancellableGroups.set(pgid, registrations);
  }
  registrations.add(token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    registrations.delete(token);
    if (registrations.size === 0) {
      cancellableGroups.delete(pgid);
      cancellation.registryDirs.delete(pgid);
      cancellation.cancelWindows.delete(pgid);
    }
  };
}

/** Register only library-owned cancellation; caller-owned handles keep their ordering. */
export function registerRunCancellation(
  child: import("node:child_process").ChildProcess,
  windows: ReturnType<typeof windowsProcessLifecycle>,
  detached: boolean,
  caller: { detached?: boolean; onSpawn?: unknown } = {},
): (() => void) | undefined {
  if (
    caller.detached ||
    caller.onSpawn ||
    (!detached && !windows.enabled) ||
    child.pid === undefined
  )
    return undefined;
  return registerCancellationGroup(child.pid, windows.dir, () =>
    windows.stop(
      child.pid,
      CANCEL_ESCALATE_MS,
      () => child.exitCode === null && child.signalCode === null,
    ),
  );
}

/**
 * Grace between a cancellation's SIGTERM and its SIGKILL.
 *
 * Deliberately shorter than the deadline's own 2s escalation, because this one
 * BLOCKS (see `cancelTrackedGroups`) and the deadline's does not. It is long
 * enough for a `gh` or `git` that does not ignore SIGTERM to act on it, and the
 * SIGKILL behind it is what covers one that does.
 */
const CANCEL_ESCALATE_MS = 250;

/**
 * Grace between the SIGTERM `run`'s deadline sends and its SIGKILL: two
 * seconds, or less when `RRC_DEADLINE_GRACE_MS` asks for it. That variable
 * exists to compress pacing in tests; it is not configuration. Clamped to
 * [10ms, 2s], so it can never lengthen the grace or remove it; unset, empty or
 * non-numeric leaves the two seconds in force.
 */
function deadlineGraceMs(): number {
  const def = 2000;
  const raw = process.env.RRC_DEADLINE_GRACE_MS ?? "";
  if (!/^[0-9]+$/.test(raw)) return def;
  return Math.min(def, Math.max(10, Number.parseInt(raw, 10)));
}

/**
 * Block this thread — the only sleep available to a signal handler that must
 * finish its work before the NEXT listener runs. `setTimeout` would not do:
 * the listeners registered after this one call `process.exit()`, which takes
 * every pending timer with it.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Signal a whole process GROUP; a gone group is the outcome we wanted anyway. */
function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH — already gone.
  }
}

/**
 * SIGTERM every tracked group, then SIGKILL whatever the grace did not end.
 *
 * SYNCHRONOUS, and both halves of that are load-bearing.
 *
 * It must not use a timer, because the listeners registered after this one may
 * call `process.exit()` — drive-pr's `drive.ts` and `lib/state/lock.ts` both do
 * — which would discard a scheduled escalation. A grace period that only
 * sometimes elapses is not a grace period.
 *
 * It must not poll for the group to disappear the way `run`'s deadline path can
 * afford to, either. Blocking this thread is what stops the event loop reaping
 * the exited leader, so it stays a zombie — still present in the process table,
 * and therefore still answering `kill(-pgid, 0)` — for as long as the poll
 * runs. Measured: 3.4s of synchronous polling never once witnessed a group
 * whose only member had already exited. So the grace is a fixed wait, not a
 * witnessed one, and `CANCEL_ESCALATE_MS` is sized for a blocking cost rather
 * than a free one.
 */
async function cancelTrackedGroups(): Promise<boolean> {
  const groups = [...cancellableGroups.keys()];
  if (groups.length === 0) return true;
  if (process.platform === "win32") {
    const results = await Promise.all(
      groups.map(
        (pid) =>
          cancellation.cancelWindows.get(pid)?.() ??
          stopWindowsTree(
            pid,
            CANCEL_ESCALATE_MS,
            cancellation.registryDirs.get(pid),
          ),
      ),
    );
    return results.every(Boolean);
  }
  for (const pgid of groups) signalGroup(pgid, "SIGTERM");
  sleepSync(CANCEL_ESCALATE_MS);
  for (const pgid of groups) signalGroup(pgid, "SIGKILL");
  return true;
}

/** Join cancellation already in progress before deciding whether resources can be released. */
export function cancelTrackedProcesses(): Promise<boolean> {
  if (cancellation.inflight) return cancellation.inflight;
  const pending = cancelTrackedGroups();
  cancellation.inflight = pending;
  const clear = (): void => {
    if (cancellation.inflight === pending) delete cancellation.inflight;
  };
  void pending.then(clear, clear);
  return pending;
}

/** The kernel awaits owned child cancellation before releasing process resources. */
if (!cancellation.handlerRegistered) {
  cancellation.handlerRegistered = true;
  registerSignalHandler(async () => {
    await cancelTrackedProcesses();
  });
}

/**
 * Spawn `argv` directly, or through cmd for Windows batch shims, and resolve
 * with its captured output. The deadline, when given, kills the child with SIGTERM,
 * escalates to SIGKILL two seconds later, and then resolves on its own
 * authority rather than waiting for 'close' (a surviving grandchild holds the
 * pipes open and would defeat the deadline entirely). Either way the result
 * reports `timedOut` and the conventional 124.
 *
 * A spawn error (binary not on PATH, say) resolves as code 127 with the error
 * text on stderr rather than rejecting: every bash call site read a failed
 * command and a missing command the same way, as a non-zero status. IT NEVER
 * REJECTS, so a caller cannot learn "nothing ran" from a `try`/`catch` — and
 * 127 does not tell it either, since a real child may exit 127 too. The result
 * says so directly instead: `spawnFailed`. Read that, never the
 * code, when the question is whether a child existed at all.
 */
export const run = traceRunner<RunResult, RunOptions>(runProcess, {});

/**
 * `gh` with the GH_CALL_TIMEOUT deadline — the `gh_call` of the bash lib.
 *
 * `timeoutSec` is an optional TIGHTENING, never a loosening: a caller holding a
 * budget smaller than `GH_CALL_TIMEOUT` can pass it, and the effective deadline
 * is whichever is smaller. Omitting it keeps the env default exactly as before.
 * Mirrors `drive-pr`'s `ghCall`, and exists here because `gh-conditional.ts`
 * passes its caller's budget through it.
 */
export const ghCall = traceGhRunner<RunResult, RunOptions>(
  (args, opts) => run(["gh", ...args], opts),
  ghCallTimeoutSeconds,
  {},
);

function runProcess(argv: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    if (shutdownRequested()) return;
    const cmd = argv[0];
    if (!cmd) {
      resolve({
        code: 127,
        stdout: "",
        stderr: "empty command",
        bufferExceeded: false,
        timedOut: false,
        spawnFailed: true,
        stderrTail: "empty command",
      });
      return;
    }
    // A DEADLINED child gets its own process group, so the deadline can kill
    // the whole tree rather than one process. `kill(pid)` reaches the child
    // only; anything it spawned — `gh`'s credential helpers, a wrapper shell —
    // survives, and goes on holding resources and running side effects after
    // this script reports the operation killed.
    //
    // ONLY when a deadline is set, and that condition is load-bearing rather
    // than incidental. Detaching costs terminal signal delivery: a Ctrl-C at
    // the tty goes to the foreground process group, so a detached child stops
    // receiving it. For converge.ts's pass command — undeadlined, inherited
    // stdio, the one child a human actually interrupts — that would mean
    // Ctrl-C killing the driver and orphaning the agent. Undeadlined children
    // therefore stay in our group and keep the interrupt; deadlined ones trade
    // it for a kill that actually reaches the tree, and their deadline is the
    // thing that ends them anyway.
    const detached =
      opts.timeoutSec !== undefined && process.platform !== "win32";
    const windows = windowsProcessLifecycle(opts.env);
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: traceEnv(windows.env) as NodeJS.ProcessEnv,
      detached,
      stdio: [
        opts.stdinInherit
          ? "inherit"
          : opts.stdin === undefined
            ? "ignore"
            : "pipe",
        opts.stdout ?? "pipe",
        opts.stderr ?? "pipe",
      ],
    };
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(argv, spawnOpts);
    } catch (e) {
      windows.dispose();
      const message = e instanceof Error ? e.message : String(e);
      resolve({
        code: 127,
        stdout: "",
        stderr: message,
        timedOut: false,
        bufferExceeded: false,
        // `spawn` threw before any child existed — the synchronous half of
        // the same fact `child.on('error')` reports asynchronously below.
        spawnFailed: true,
        stderrTail: lastBytes(message),
      });
      return;
    }

    windows.bind(child);

    // Tracked for the whole time it is live, so a signal to this process is
    // forwarded into the group `detached` just put it beyond reach of. Only a
    // group THIS library detached on its own initiative: an undetached child
    // still shares our group and gets the terminal's signals directly.
    const unregisterGroup = registerRunCancellation(child, windows, detached);

    let timedOut = false;
    let spawnFailed = false;
    let groupSurvived = false;
    let terminationSignal: NodeJS.Signals | undefined;

    const timers: ProcessTimers = {};
    const output = captureProcessOutput(child, opts, {
      timedOut: () => timedOut,
      timers,
      signalTree: (signal) => signalTree(signal),
      settle: (code) => settle(code),
    });

    const settle = (code: number, extraErr?: string) =>
      windows.finish(() => {
        if (timers.kill) clearTimeout(timers.kill);
        if (timers.escalate) clearTimeout(timers.escalate);
        // Untracked here rather than on 'close', because `settle` is also the
        // deadline's own exit path — which fires while the group may still be
        // dying. A stale pgid in the set would have a later cancellation signal
        // a number the kernel has since handed to something else.
        unregisterGroup?.();
        resolve({
          code,
          stdout: output.stdout,
          stderr: output.stderr || (extraErr ?? ""),
          timedOut,
          bufferExceeded: output.bufferExceeded,
          spawnFailed,
          ...(terminationSignal ? { signal: terminationSignal } : {}),
          stderrTail:
            code === 0 ? "" : lastBytes(output.tail || (extraErr ?? "")),
          ...(opts.reapGroup
            ? { groupSurvived: groupSurvived || windows.groupSurvived }
            : {}),
        });
      });

    // Signal the whole tree where we can, the child alone where we cannot.
    //
    // POSIX: a negative pid addresses the process GROUP, which `detached`
    // above made the child the leader of — so every descendant that has not
    // called setpgid gets the signal. ESRCH just means the group is already
    // gone; anything else falls back to the single child rather than leaving
    // it running.
    //
    const signalTree = (sig: NodeJS.Signals) =>
      windows.signal(child, detached, sig);

    armProcessDeadline(
      child,
      timers,
      opts.timeoutSec,
      deadlineGraceMs,
      () => {
        timedOut = true;
      },
      signalTree,
      settle,
    );

    // Set BEFORE `settle`, exactly as `timedOut` and `output.bufferExceeded` are, so
    // the flag is on the result this handler produces.
    //
    // Node emits 'error' for a handful of causes, and a failed spawn is only
    // the first: a kill that could not be delivered can raise it too, AFTER a
    // child really ran. That mislabels nothing that matters — `settle` is
    // idempotent, so a post-exit 'error' never reaches here, and the residual
    // case would make `converge.ts` DECLINE to release a lease it could have,
    // which is the harmless direction (the record expires by staleness, the
    // behaviour without the release). The dangerous direction is the reverse, and
    // this flag exists to close it.
    child.on("error", (e) => {
      spawnFailed = true;
      settle(127, e.message);
    });
    // The reap runs on 'exit', not 'close': 'close' also waits for the output
    // pipes, which a background descendant inherited and holds open, so on
    // 'close' that descendant has already done its work (and usually gone).
    // Killing the group here closes those pipes, and 'close' then settles.
    child.on("exit", (_code, signal) => {
      terminationSignal = signal ?? undefined;
      if (timedOut || output.bufferExceeded) return;
      if (opts.reapGroup && windows.enabled) {
        windows.reap(child.pid);
        return;
      }
      if (opts.reapGroup && detached && groupAlive(child.pid)) {
        groupSurvived = true;
        signalTree("SIGKILL");
      }
    });
    child.on("close", (code) => {
      // A timed-out (or buffer-killed) child that exits on SIGTERM cancels its
      // own escalation: `settle` clears `timers.escalate`, so if 'close' fires
      // before the two seconds elapse the group SIGKILL never happens and the
      // tree leaks anyway, while this wrapper reports the wrong outcome
      //. So the kill moves here, where it
      // cannot be raced.
      if (timedOut || output.bufferExceeded) signalTree("SIGKILL");
      else if (opts.reapGroup && detached && groupAlive(child.pid)) {
        groupSurvived = true;
        signalTree("SIGKILL");
      }
      settle(timedOut ? 124 : output.bufferExceeded ? 1 : (code ?? 1));
    });

    writeChildInput(child.stdin, opts.stdin);
  });
}

/**
 * `git`. Undeadlined BY DEFAULT: the calls it serves are local
 * (`rev-parse`) and cannot hang on a network the way `gh` can — which is why
 * `ghCall` carries a deadline and this does not. A caller adding a
 * remote-facing subcommand (`fetch`, `push`, `ls-remote`) must pass its own
 * `timeoutSec`.
 */
export function git(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(["git", ...args], opts);
}

/**
 * Argv for a sibling `.ts` script, run under the SAME Bun binary executing
 * this one (`process.execPath`) — the cross-platform replacement for relying
 * on a `#!/usr/bin/env bun` shebang, which Windows cannot honour. There is no
 * PATH lookup for `bun` either, so a shell that has not activated mise cannot
 * make it fail.
 */
export function tsArgv(scriptPath: string, args: string[] = []): string[] {
  return [process.execPath, scriptPath, ...args];
}

/**
 * Resolve the PR number: an explicit argument wins; otherwise ask `gh` for
 * the current branch's PR. Returns '' when neither yields one — each caller
 * owns its own refusal message, as the bash scripts did.
 */
export async function resolvePr(explicit: string): Promise<string> {
  if (explicit !== "") return explicit;
  const r = await ghCall(["pr", "view", "--json", "number", "-q", ".number"], {
    stderr: "ignore",
  });
  if (r.code !== 0) return "";
  return r.stdout.trim();
}
