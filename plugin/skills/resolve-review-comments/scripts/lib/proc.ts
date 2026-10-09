/**
 * Process spawning with deadlines — the TypeScript successor to
 * `lib/gh-deadline.sh`, and (with `gh.ts`) the place `gh` is spawned from.
 *
 * Bound every outbound `gh` call. `gh` has no timeout of its own, and none of
 * this skill's scripts can supply one from their poll loops: a deadline is only
 * ever consulted BETWEEN calls, so an accepted-but-never-completed connection
 * parks the driver past every advertised deadline — mode 13 in drive-pr's
 * references/terminal-states.md.
 *
 * The bash version leaned on coreutils `timeout` with a `perl -e alarm`
 * fallback, because a shell cannot kill a child it is blocked reading from.
 * A JS runtime can: the deadline is a timer in the SAME process that spawned
 * the child, so there is no watchdog to outlive the script and no PID-reuse
 * hazard (the measured failure that ruled out the background-and-kill shell
 * pattern, TASK) — and no dependency on either external binary, which is
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
 * failure mode this file exists to prevent (docomply-review, a reference-implementation pull request
 * round 10). A non-numeric or non-positive value is a caller mistake, not a
 * configuration to tolerate, so it is rejected rather than quietly floored.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { fail } from "./cli.ts";

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
  // generous (docomply-review, a reference-implementation pull request round 4). A value that cannot be
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
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** `true` when captured stdout+stderr hit `maxBufferBytes` and the child was killed for it. */
  bufferExceeded: boolean;
  /**
   * `true` when NO CHILD EVER RAN — the binary was not on `PATH`, the path did
   * not resolve, `spawn` itself refused the arguments.
   *
   * `code` alone cannot answer this and must not be used to (TASK). A
   * failed spawn reports 127 because every bash call site read a missing
   * command and a failed one the same way (see `run`'s header), but 127 is
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
}

/**
 * The old `ghOrExit`'s own explicit `spawnSync` `maxBuffer` (NOT Node's
 * default, which is 1 MiB), kept as this port's default too: one caller
 * (`list-unresolved-threads.ts --paginate`) pages a whole PR's review threads
 * into a single document, so the bound has to be generous — but a bound of
 * some size is what stands between a runaway `gh` response and this
 * process's heap, and `run()`'s `data` handlers accumulate into JS strings
 * with no bound of their own (docomply-review, a reference-implementation pull request).
 */
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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
  /** Overrides `MAX_BUFFER_BYTES` — a test knob, not a per-caller tuning lever. */
  maxBufferBytes?: number;
  /**
   * Test-only: fires once per stdout/stderr chunk with whether it was
   * captured or discarded past the buffer cap. Lets a test assert directly
   * that later chunks are excluded, rather than inferring it from a captured
   * byte count a real OS pipe's chunking makes an unreliable proxy
   * (docomply-review, a reference-implementation pull request round 3).
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
 * believes the operation was cancelled (chatgpt-codex-connector, a reference-implementation pull request
 * against the bash `gh-deadline.sh`; reproduced unchanged against this port,
 * TASK — the subshell the finding named is gone, the isolated group it was
 * compounded by is not).
 */
interface CancellationRegistry {
  groups: Map<number, Set<symbol>>;
  handlers: Map<NodeJS.Signals, () => void>;
}
const registryKey = Symbol.for("groundwork.review.process-cancellation.v1");
const globalRegistry = globalThis as typeof globalThis & {
  [key: symbol]: CancellationRegistry | undefined;
};
const cancellation = globalRegistry[registryKey] ?? {
  groups: new Map<number, Set<symbol>>(),
  handlers: new Map<NodeJS.Signals, () => void>(),
};
globalRegistry[registryKey] = cancellation;
const cancellableGroups = cancellation.groups;

/** Share cancellation ownership with consumer runners; release on settlement. */
export function registerCancellationGroup(pgid: number): () => void {
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
    if (registrations.size === 0) cancellableGroups.delete(pgid);
  };
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
function cancelTrackedGroups(): void {
  const groups = [...cancellableGroups.keys()];
  if (groups.length === 0) return;
  for (const pgid of groups) signalGroup(pgid, "SIGTERM");
  sleepSync(CANCEL_ESCALATE_MS);
  for (const pgid of groups) signalGroup(pgid, "SIGKILL");
}

/**
 * Cancellation reaches a script as one of these. HUP is in the set because a
 * driver whose terminal goes away gets one instead of a TERM.
 */
const CANCEL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Forward a cancellation from THIS process into the isolated groups it spawned.
 *
 * Installed at MODULE LOAD rather than per call, and that is the whole fix. The
 * bash predecessor installed its traps inside `with_deadline`, so they lived in
 * the `$( )` subshell every call site wrapped it in and no signal ever reached
 * them; the port replaced the subshell with an in-process timer but kept the
 * isolated group, so the same signal still reached nothing. A handler has to
 * exist in the process that actually receives the signal, before anything can
 * be spawned — which for a module is import time. Registration order matters
 * for the same reason: listeners run in the order they were added, and a
 * handler added later than `drive.ts`'s or `lock.ts`'s would run after they had
 * already called `process.exit()`, i.e. never.
 *
 * Registering a listener SUPPRESSES the signal's default disposition, so this
 * one restores it — but only once it is safe to, i.e. once nothing else is
 * still listening. It stays registered across repeat signals as long as a
 * caller listener is also present: removing itself unconditionally after the
 * first occurrence (an earlier version of this code did) stops forwarding on
 * every later occurrence of the same signal, so a caller that handles or
 * temporarily swallows one without exiting — a retry loop, a debounced
 * shutdown — silently regains the original unforwarded-cancellation bug for
 * every signal after its first. Only when this is the LAST listener does it
 * remove itself and re-raise, so the process dies from the signal exactly as
 * it would have with no handler at all — that's what keeps a cancellation
 * unmaskable by a caller that merely swallowed the `RunResult`. When another
 * listener is present, that listener runs next in this same dispatch and owns
 * the outcome; re-raising would only run it twice, so it's skipped, and the
 * forwarder is left in place for whatever signal comes next. This is the
 * #3997 guarantee that a caller's own INT/TERM/HUP handlers survive a
 * `gh_call`, kept by construction rather than by capture-and-restore.
 */
for (const sig of CANCEL_SIGNALS) {
  if (cancellation.handlers.has(sig)) continue;
  const forward = (): void => {
    cancelTrackedGroups();
    if (process.listenerCount(sig) === 1) {
      // bun-types 1.4.0 regression: process.removeListener/off overloads
      // collapse to only "memoryPressure" (process.on still accepts signals).
      // Cast through EventEmitter until upstream restores the overloads.
      (process as unknown as import("node:events").EventEmitter).removeListener(
        sig,
        forward,
      );
      cancellation.handlers.delete(sig);
      process.kill(process.pid, sig);
    }
  };
  cancellation.handlers.set(sig, forward);
  process.on(sig, forward);
}

/**
 * Spawn `argv` directly — never through a shell — and resolve with its
 * captured output. The deadline, when given, kills the child with SIGTERM,
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
 * says so directly instead: `spawnFailed` (TASK). Read that, never the
 * code, when the question is whether a child existed at all.
 */
export function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolve({
        code: 127,
        stdout: "",
        stderr: "empty command",
        bufferExceeded: false,
        timedOut: false,
        spawnFailed: true,
      });
      return;
    }
    // A DEADLINED child gets its own process group, so the deadline can kill
    // the whole tree rather than one process. `kill(pid)` reaches the child
    // only; anything it spawned — `gh`'s credential helpers, a wrapper shell —
    // survives, and goes on holding resources and running side effects after
    // this script reports the operation killed (docomply-review, a reference-implementation pull request
    // round 2).
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
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      resolve({
        code: 127,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        bufferExceeded: false,
        // `spawn` threw before any child existed — the synchronous half of
        // the same fact `child.on('error')` reports asynchronously below.
        spawnFailed: true,
      });
      return;
    }

    // Tracked for the whole time it is live, so a signal to this process is
    // forwarded into the group `detached` just put it beyond reach of. Only a
    // group THIS library detached on its own initiative: an undetached child
    // still shares our group and gets the terminal's signals directly.
    const cancellableGroup = detached ? child.pid : undefined;
    const unregisterGroup =
      cancellableGroup === undefined
        ? undefined
        : registerCancellationGroup(cancellableGroup);

    let out = "";
    let err = "";
    let timedOut = false;
    let bufferExceeded = false;
    let spawnFailed = false;
    // Tracked incrementally rather than re-derived from `Buffer.byteLength(out)
    // + Buffer.byteLength(err)` on every chunk: the latter rescans the WHOLE
    // accumulated string per 'data' event, so capture cost grows with the
    // square of the byte count as the cap is approached (docomply-review, PR
    // #4054 round 2).
    let capturedBytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    let escalateTimer: NodeJS.Timeout | undefined;
    const maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER_BYTES;

    // Mirrors the deadline's own SIGTERM-then-SIGKILL escalation (below) —
    // a runaway response is killed the same way a hung one is, just on a
    // byte trigger instead of a clock. Guarded by `bufferExceeded` so a burst
    // that arrives across two 'data' events cannot schedule the escalation
    // twice, and skipped once `timedOut` already owns the shutdown.
    const enforceBufferLimit = () => {
      if (bufferExceeded || timedOut) return;
      if (capturedBytes <= maxBufferBytes) return;
      bufferExceeded = true;
      if (killTimer) clearTimeout(killTimer);
      signalTree("SIGTERM");
      escalateTimer = setTimeout(() => {
        signalTree("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settle(1);
      }, 2000);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      // Discarded once EITHER kill path has fired, not just the buffer cap:
      // SIGTERM does not stop the child instantly under the deadline either,
      // and a child that ignores it (or a descendant that keeps writing
      // through either escalation's two-second grace) can go on emitting
      // data right up to the SIGKILL. Gating this on `bufferExceeded` alone
      // left the DEADLINE's own escalation window uncapped — `timedOut` sets
      // and `enforceBufferLimit` no-ops forever, but nothing stopped these
      // handlers from still appending (chatgpt-codex-connector, a reference-implementation pull request
      // round 4).
      const captured = !(bufferExceeded || timedOut);
      if (captured) {
        out += d;
        capturedBytes += Buffer.byteLength(d);
      }
      opts.onChunk?.("stdout", Buffer.byteLength(d), captured);
      enforceBufferLimit();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      const captured = !(bufferExceeded || timedOut);
      if (captured) {
        err += d;
        capturedBytes += Buffer.byteLength(d);
      }
      opts.onChunk?.("stderr", Buffer.byteLength(d), captured);
      enforceBufferLimit();
    });

    const settle = (code: number, extraErr?: string) => {
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      // Untracked here rather than on 'close', because `settle` is also the
      // deadline's own exit path — which fires while the group may still be
      // dying. A stale pgid in the set would have a later cancellation signal
      // a number the kernel has since handed to something else.
      unregisterGroup?.();
      resolve({
        code,
        stdout: out,
        stderr: err || (extraErr ?? ""),
        timedOut,
        bufferExceeded,
        spawnFailed,
      });
    };

    // Signal the whole tree where we can, the child alone where we cannot.
    //
    // POSIX: a negative pid addresses the process GROUP, which `detached`
    // above made the child the leader of — so every descendant that has not
    // called setpgid gets the signal. ESRCH just means the group is already
    // gone; anything else falls back to the single child rather than leaving
    // it running.
    //
    // Windows has no process groups to signal: `taskkill /T` is the platform's
    // own answer, walking the child tree by parent pid. It is spawned
    // fire-and-forget — we are already inside a deadline, and waiting on the
    // killer to confirm a kill would reintroduce the unbounded wait.
    const signalTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        if (sig === "SIGKILL") {
          try {
            const killer = spawn(
              "taskkill",
              ["/pid", String(child.pid), "/t", "/f"],
              { stdio: "ignore" },
            );
            // `spawn` reports a failure to START asynchronously, as an 'error'
            // event — the surrounding try/catch never sees it, and an
            // unhandled one on a ChildProcess throws. So the fallback has to
            // be a listener, not a catch block, or a machine without taskkill
            // loses the kill AND crashes the driver (coderabbitai, PR #4034
            // round 4). Attached BEFORE unref, which only detaches it from the
            // event loop and does not remove listeners.
            killer.on("error", () => {
              try {
                child.kill(sig);
              } catch {
                // already gone
              }
            });
            killer.unref();
          } catch {
            child.kill(sig);
          }
        }
        return;
      }
      try {
        if (detached) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };

    if (opts.timeoutSec !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true;
        signalTree("SIGTERM");
        escalateTimer = setTimeout(() => {
          signalTree("SIGKILL");
          // Settle on the DEADLINE's terms, not on 'close'.
          //
          // 'close' waits for the stdio streams as well as the exit, and every
          // descendant inherited those streams — so it does not fire while any
          // of them lives, and the deadline that just fired would go on
          // waiting for a grandchild. That is the very hang this timer exists
          // to bound, so it must not be reachable through it. Measured in the
          // drive-pr copy, PR #4034 round 1.
          //
          // Destroying our ends of the pipes is what lets the runtime exit
          // afterwards — an orphaned grandchild holding a live handle would
          // otherwise keep the event loop alive past the resolved promise.
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          settle(124);
        }, 2000);
      }, opts.timeoutSec * 1000);
    }

    // Set BEFORE `settle`, exactly as `timedOut` and `bufferExceeded` are, so
    // the flag is on the result this handler produces.
    //
    // Node emits 'error' for a handful of causes, and a failed spawn is only
    // the first: a kill that could not be delivered can raise it too, AFTER a
    // child really ran. That mislabels nothing that matters — `settle` is
    // idempotent, so a post-exit 'error' never reaches here, and the residual
    // case would make `converge.ts` DECLINE to release a lease it could have,
    // which is the harmless direction (the record expires by staleness, the
    // pre-TASK behaviour). The dangerous direction is the reverse, and
    // this flag exists to close it.
    child.on("error", (e) => {
      spawnFailed = true;
      settle(127, e.message);
    });
    child.on("close", (code) => {
      // A timed-out (or buffer-killed) child that exits on SIGTERM cancels its
      // own escalation: `settle` clears `escalateTimer`, so if 'close' fires
      // before the two seconds elapse the group SIGKILL never happens and the
      // tree leaks anyway, while this wrapper reports the wrong outcome
      // (docomply-review, a reference-implementation pull request round 3). So the kill moves here, where it
      // cannot be raced.
      if (timedOut || bufferExceeded) signalTree("SIGKILL");
      settle(timedOut ? 124 : bufferExceeded ? 1 : (code ?? 1));
    });

    if (opts.stdin !== undefined && child.stdin) {
      // A child that exits, or closes its input, before this write completes
      // makes the pipe emit EPIPE on the stream. A writable stream with no
      // 'error' listener raises that as an UNHANDLED error, which terminates
      // the driver outright instead of resolving the RunResult this function
      // advertises (docomply-review, a reference-implementation pull request round 1). Absorbed rather than
      // reported: the child's own exit status is the meaningful answer, and
      // `close` still settles the promise with it.
      child.stdin.on("error", () => {
        // Deliberately empty: the listener's existence is the whole fix.
      });
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/**
 * `gh` with the GH_CALL_TIMEOUT deadline — the `gh_call` of the bash lib.
 *
 * `timeoutSec` is an optional TIGHTENING, never a loosening: a caller holding a
 * budget smaller than `GH_CALL_TIMEOUT` can pass it, and the effective deadline
 * is whichever is smaller. Omitting it keeps the env default exactly as before.
 * Mirrors `drive-pr`'s `ghCall`, and exists here because the parity copy of
 * `lib/gh-conditional.ts` passes its caller's budget through it (TASK).
 */
export function ghCall(
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const envDeadline = ghCallTimeoutSeconds();
  const { timeoutSec, ...rest } = opts;
  return run(["gh", ...args], {
    ...rest,
    timeoutSec:
      timeoutSec === undefined
        ? envDeadline
        : Math.max(1, Math.min(envDeadline, timeoutSec)),
  });
}

/**
 * `git`. Undeadlined BY DEFAULT: every call in this skill is local
 * (`rev-parse`) and cannot hang on a network the way `gh` can — which is why
 * `ghCall` carries a deadline and this does not. A caller adding a
 * remote-facing subcommand (`fetch`, `push`, `ls-remote`) must pass its own
 * `timeoutSec`.
 */
export function git(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(["git", ...args], opts);
}

/**
 * Argv for a sibling `.ts` script, run under the SAME runtime executing this
 * one (`process.execPath` is bun under bun, node under node) — the
 * cross-platform replacement for relying on a `#!/usr/bin/env bun` shebang,
 * which Windows cannot honour. This also retires the bash scripts' need to
 * source `mise-init.sh` before shelling out to `bun`: there is no PATH lookup
 * left to fail.
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
