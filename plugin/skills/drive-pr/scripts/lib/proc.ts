import {
  captureProcessOutput,
  type ProcessTimers,
} from "../../../../shared/process-output.ts";
import { windowsProcessLifecycle } from "../../../../shared/windows-process.ts";
import { processTable } from "../../../../shared/process-table.ts";
/**
 * Process spawning with deadlines — the TypeScript successor to
 * `lib/gh-deadline.sh`, and the ONE place `gh` is ever spawned from.
 *
 * Bound every outbound `gh` call. `gh` has no timeout of its own, and none of
 * this skill's scripts can supply one from their poll loops: a deadline is only
 * ever consulted BETWEEN calls, so an accepted-but-never-completed connection
 * parks the driver past every advertised deadline. That is mode 13 in
 * references/terminal-states.md.
 *
 * The bash version leaned on coreutils `timeout` with a `perl -e alarm`
 * fallback, because a shell cannot kill a child it is blocked reading from.
 * A JS runtime can: the deadline is a timer in the SAME process that spawned
 * the child, so there is no watchdog to outlive the script and no PID-reuse
 * hazard (the measured failure that ruled out the background-and-kill shell
 * pattern) — and no dependency on either external binary, which is what makes
 * this port run on Windows at all.
 *
 * Callers may pre-set GH_CALL_TIMEOUT; it is honoured, not overwritten — but
 * only when it is a positive whole number of seconds. GNU `timeout 0` disables
 * the timeout outright rather than firing immediately, and the bash lib refused
 * `0` for exactly that reason; the refusal is kept even though a JS timer would
 * technically fire, because a caller writing `0` is asking for an unbounded
 * call whichever implementation they get, and that is the exact failure mode
 * this file exists to prevent. A non-numeric or non-positive value is a caller
 * mistake, not a configuration to tolerate, so it is rejected rather than
 * quietly floored.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import {
  traceRunner,
  traceEnv,
  traceGhRunner,
} from "../../../../shared/trace.ts";
import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  lastBytes,
  readTimeoutEnv,
  registerRunCancellation,
  writeChildInput,
} from "../../../../shared/proc.ts";
import { fail, testPacing } from "./cli.ts";

// The review skill's process layer is the shared base: its timeout reader,
// and its process-wide cancellation registry and signal forwarder, which
// importing it installs once for every helper loaded in this process. This
// module adds the drive loop's richer `run` (stop handles, group witnesses,
// output caps) and its own deadlines on top. Each skill keeps its own
// `fail`/`ExitError`, so the accessors that refuse stay here.
export { readTimeoutEnv };

/**
 * GH_CALL_TIMEOUT with `gh-deadline.sh`'s own refusal semantics (exit 1).
 * Evaluated per call so an entry script that validates the variable itself
 * with a different exit code (resolve-held-thread, exit 2) can run its check
 * first.
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

/**
 * GIT_CALL_TIMEOUT, the same convention as `ghCallTimeoutSeconds()` above but
 * for local `git` calls — a stalled filesystem or a lock held by another
 * process can hang one exactly as an unresponsive API can hang a `gh` call,
 * and a local subprocess earns no exemption from the deadline discipline this
 * file exists to enforce.
 */
export function gitCallTimeoutSeconds(): number {
  const read = readTimeoutEnv("GIT_CALL_TIMEOUT", 30);
  if (read.ok) return read.seconds;
  if (/^0+$/.test(read.raw)) {
    fail(
      1,
      "git-deadline: GIT_CALL_TIMEOUT=0 disables the deadline instead of firing immediately — refusing",
    );
  }
  fail(
    1,
    `git-deadline: GIT_CALL_TIMEOUT must be a positive whole number of seconds no`,
    `greater than 2147483 (got '${read.raw}') — beyond that the millisecond delay`,
    "overflows a 32-bit timer and fires immediately, inverting the deadline.",
  );
}

/**
 * `$DRIVE_PR_HELPER_TIMEOUT`, the deadline SKILL.md documents for one spawned
 * helper subprocess, with the same refusal semantics as the helpers above.
 *
 * A helper reaches the network through its OWN `gh` chokepoint, so it is
 * already deadlined per call — this bounds the whole invocation, which the
 * per-call deadline cannot: a wedged runtime never gets as far as its first
 * `gh` call, and a caller waiting on the pipe waits forever for a process that
 * has not started doing anything to time out (the same startup-hang class this
 * skill fixed for `reconcile-replied-threads.ts`'s trusted-associations spawn).
 *
 * Scripts that validate this variable with a DIFFERENT exit code — an entry
 * script whose own usage contract says 2 — read it through `readTimeoutEnv`
 * directly and keep doing so; this accessor is for callers that want the
 * ordinary exit-1 refusal.
 */
export function helperTimeoutSeconds(): number {
  const read = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  if (read.ok) return read.seconds;
  if (/^0+$/.test(read.raw)) {
    fail(
      1,
      "helper-deadline: DRIVE_PR_HELPER_TIMEOUT=0 disables the deadline instead of firing immediately — refusing",
    );
  }
  fail(
    1,
    "helper-deadline: DRIVE_PR_HELPER_TIMEOUT must be a positive whole number of seconds no",
    `greater than 2147483 (got '${read.raw}') — beyond that the millisecond delay`,
    "overflows a 32-bit timer and fires immediately, inverting the deadline.",
  );
}

/**
 * The deadline `drive.ts` gives its OWN spawn of `mark-ready.ts` — larger than
 * `helperTimeoutSeconds()`, deliberately. That accessor bounds "one spawned
 * helper subprocess" as a single unit, which is the right model for most of
 * `drive.ts`'s spawns — but `mark-ready.ts` is not one network call, it is up
 * to SEVEN sequential ones on the dispatch path that actually fires `gh pr
 * ready`, each individually entitled to its own full budget:
 *
 *   1. `ready-marked` (helper) — the durable-claim read at the very top
 *   2. the initial `readSnapshot` (gh)
 *   3. `claim-ready-mark` (helper)
 *   4. `renew-ready-mark` (helper)
 *   5. `gh pr ready` itself (gh)
 *   6. the follow-up `readSnapshot`, ambiguous-outcome path only (gh)
 *   7. `commit-ready-mark` (helper)
 *
 * Bounding the whole spawn at one helper-timeout-worth of time means the
 * parent can kill it after step 5 applied server-side but before step 7
 * persists that fact — and once the claim lease then expires, a later
 * re-drafted PR can fire `ready_for_review` a second time, defeating the
 * once-only guarantee this whole file exists to protect.
 *
 * The COMPLETE derived bound, not a flat multiplier that happens to clear
 * today's defaults (a `4 * helperTimeoutSeconds()` version of this undercounted
 * the real chain: four helper-bound calls AND three `gh`-bound ones, not four
 * of either alone). Summed in each call's own unit rather than approximated in
 * helper-only units, so a caller that configures `GH_CALL_TIMEOUT` far from
 * `DRIVE_PR_HELPER_TIMEOUT`'s default ratio still gets a bound that actually
 * covers the chain — plus one full `KILL_ESCALATE_MS` grace per step, since a
 * deadline that fires still spends that grace before the child is actually
 * gone.
 *
 * `helperTimeoutSeconds()` and `ghCallTimeoutSeconds()` each individually
 * refuse a value whose OWN `* 1000` would overflow `setTimeout`'s 32-bit signed
 * millisecond delay — but this function sums up to seven of them, so two
 * individually-valid inputs (e.g. `DRIVE_PR_HELPER_TIMEOUT` near its own
 * ~2147483s ceiling) can still produce a total that overflows here even though
 * neither accessor it called from ever saw an invalid value itself. The
 * overflow lands three calls away from this function, inside `run()`'s own
 * `timeoutSec * 1000` — silently firing the deadline immediately rather than
 * refusing loudly — so this is the one place that can still catch it. A
 * caller-supplied env var earns a refusal (readTimeoutEnv); this is a derived
 * internal value with no user to refuse, so it clamps to the same 32-bit
 * ceiling instead — "as generous as representable" rather than an accidental
 * near-zero deadline.
 */
export function markReadyTimeoutSeconds(): number {
  const HELPER_BOUND_CALLS = 4; // ready-marked, claim, renew, commit
  const GH_BOUND_CALLS = 3; // initial + follow-up readSnapshot, gh pr ready
  const TOTAL_CALLS = HELPER_BOUND_CALLS + GH_BOUND_CALLS;
  const totalSeconds =
    HELPER_BOUND_CALLS * helperTimeoutSeconds() +
    GH_BOUND_CALLS * ghCallTimeoutSeconds() +
    TOTAL_CALLS * (KILL_ESCALATE_MS / 1000);
  const MAX_SAFE_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);
  return Math.min(totalSeconds, MAX_SAFE_TIMEOUT_SECONDS);
}

/**
 * The deadline for one `ci-hold.ts` transition. Its longest path consumes a
 * remote/state-lock budget, one local git read, and up to twenty GitHub calls
 * (rollback's probes plus both bounded restoration-observation loops). The
 * parent must outlive that whole sequence: killing it after GitHub applied a
 * label but before ownership was persisted would leave an unowned hold that
 * only a human could safely remove.
 */
export function ciHoldTimeoutSeconds(): number {
  // Mirrors state/lock.ts's fixed acquisition cap. Kept explicit here to
  // avoid a proc.ts ↔ lock.ts import cycle in the shared timeout layer.
  // One PR-wide remote lock plus as many as three sequential state commits
  // (intent, recovery, settled ownership) on the crash-recovery paths.
  const STATE_LOCK_BUDGET_SECONDS = 1200;
  const GH_BOUND_CALLS = 20; // rollback probes + release mutation/retries/restore
  const GIT_BOUND_CALLS = 1; // exact local push-head check on ensure
  const TOTAL_CALLS = 1 + GH_BOUND_CALLS + GIT_BOUND_CALLS;
  const TIMELINE_RETRY_WAIT_SECONDS = 6;
  const totalSeconds =
    STATE_LOCK_BUDGET_SECONDS +
    GH_BOUND_CALLS * ghCallTimeoutSeconds() +
    GIT_BOUND_CALLS * gitCallTimeoutSeconds() +
    TOTAL_CALLS * (KILL_ESCALATE_MS / 1000) +
    TIMELINE_RETRY_WAIT_SECONDS;
  const MAX_SAFE_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);
  return Math.min(totalSeconds, MAX_SAFE_TIMEOUT_SECONDS);
}

/** Whole-process bound for drive-state set-verified's fail-closed evidence chain. */
export function finalVerifyTimeoutSeconds(): number {
  // The success path's own sequential GitHub calls, not a rounded estimate:
  // the initial PR-view read (1) + the initial timeline read (1) + the
  // initial proveCiGreen() (3: check-runs, then checkRunsFor/commitStatusesFor
  // in parallel) + preWrite's stillFullyCurrent() (5: PR view + timeline +
  // its own proveCiGreen()'s 3) + postWrite's stillFullyCurrent() (another
  // 5) = 15. A budget of 7 left the parent free to kill this child after
  // store.update() persisted verifiedSha but before the compensating
  // post-write check could clear it on a stale head/hold/CI — the exact
  // false-certificate window the post-write check exists to close.
  //
  // On top of that chain: the CI policy's own reads (2: the PR's base
  // branch, then its protection and rulesets in parallel), and per proof,
  // when a pinned requirement falls back to commit statuses, the status
  // list (1) plus one app lookup per publisher, capped at
  // MAX_STATUS_PUBLISHERS (lib/status/evidence.ts, mirrored here to keep
  // the shared timeout layer free of that import). A failed lookup is not
  // cached, so each of the three proofs may repeat them.
  const PROOFS = 3;
  const MAX_STATUS_PUBLISHERS = 4;
  const GH_BOUND_CALLS = 15 + 2 + PROOFS * (1 + MAX_STATUS_PUBLISHERS);
  // set-verified can take THREE separate lock acquisitions in its worst case,
  // not two: the PR-wide remote-mutation lock, the state mutex for the
  // certificate write, and — when the post-write `stillFullyCurrent()` check
  // finds stale evidence — a SECOND, independent state-mutex acquisition for
  // the compensating clear at drive-state.ts's postWrite failure branch
  // (`store.update((s) => s.verifiedSha === a.sha ? { ...s, verifiedSha: '' } :
  // s)`). A budget covering only the first two left `drive.ts` free to kill the
  // child while that clear was still waiting on its own lock, leaving the stale
  // certificate persisted. Each acquisition can legitimately wait the full
  // `LOCK_ACQUIRE_MAX_SEC` (300s, `lib/state/lock.ts` — mirrored as a literal
  // here for the same reason `ciHoldTimeoutSeconds()` mirrors its own lock
  // constant just above: importing it would cycle proc.ts back through lock.ts
  // in the shared timeout layer).
  const LOCK_BUDGET_SECONDS = 900;
  const totalSeconds =
    LOCK_BUDGET_SECONDS +
    GH_BOUND_CALLS * ghCallTimeoutSeconds() +
    GH_BOUND_CALLS * (KILL_ESCALATE_MS / 1000);
  return Math.min(totalSeconds, Math.floor(2_147_483_647 / 1000));
}

/** Whole-process bound for drive-status.ts --once's sequential evidence chain. */
export function driveStatusOnceTimeoutSeconds(): number {
  // One invocation can run the reconciliation helper and then issue its own
  // GitHub/git evidence reads. Keep the parent above every individually
  // bounded child even when operators skew the three timeout knobs away from
  // their default ratio; the per-call escalation grace is part of the bound.
  const HELPER_BOUND_CALLS = 8;
  const GH_BOUND_CALLS = 12;
  const GIT_BOUND_CALLS = 6;
  const TOTAL_CALLS = HELPER_BOUND_CALLS + GH_BOUND_CALLS + GIT_BOUND_CALLS;
  const totalSeconds =
    HELPER_BOUND_CALLS * helperTimeoutSeconds() +
    GH_BOUND_CALLS * ghCallTimeoutSeconds() +
    GIT_BOUND_CALLS * gitCallTimeoutSeconds() +
    TOTAL_CALLS * (KILL_ESCALATE_MS / 1000);
  return Math.min(totalSeconds, Math.floor(2_147_483_647 / 1000));
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
   * `code` alone cannot answer this and must not be used to. A
   * failed spawn reports 127 because every bash call site read a missing
   * command and a failed one the same way (see `run`'s header), but 127 is
   * also an exit code a REAL child may legitimately return — a shell wrapper
   * whose own inner command was missing being the obvious case. The two are
   * opposite facts about whether anything happened, and a caller that has to
   * know cannot recover the difference downstream.
   *
   * Added for the SIBLING skill's `converge.ts`, which releases this skill's
   * tier-3 lease only when a pass ACTUALLY RAN and could therefore hold a
   * claim; keyed on `code !== 0` instead, a `codex` binary missing from `PATH`
   * released a record that invocation never took. Carried here because
   * `/resolve-review-comments`' `proc.ts` is a hand-ported PARITY COPY of this
   * file (see the header) and a field on one side only is exactly the drift
   * that contract exists to prevent. Reported as a separate field rather than
   * folded into `code` so no existing caller's exit-status reading changes.
   */
  spawnFailed: boolean;
  /**
   * The last 4 KiB of the child's error output when it failed (any non-zero
   * `code`), `""` when it succeeded: the shared `RunResult.stderrTail`.
   */
  stderrTail: string;
}

/**
 * The old `ghOrExit`'s own explicit `spawnSync` `maxBuffer` (NOT Node's
 * default, which is 1 MiB), kept as this port's default too: a bound of some
 * size is what stands between a runaway `gh`/`git` response and this process's
 * heap — `run()`'s `data` handlers accumulate into JS strings with no bound of
 * their own otherwise (ported from the sibling `/resolve-review-comments` copy,
 * which documents the parity-copy maintenance contract this follows).
 */
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * A live child, handed to `RunOptions.onSpawn` the moment it exists, so a
 * caller can END it on an event of its own rather than only on a deadline.
 *
 * `drive.ts` is the caller this exists for. Its pass command is undeadlined by
 * design — a review round takes as long as it takes — but two events must still
 * terminate it: losing the single-instance lock mid-pass (the pass would go on
 * editing and pushing on behalf of a claim another driver now holds), and a
 * SIGINT/SIGTERM that reaches only the driver pid (releasing the locks while
 * the pass lives is the same concurrency by a different route).
 */
export interface RunHandle {
  /**
   * SIGTERM the child — its whole process group where the platform has one —
   * escalating to SIGKILL after a grace period, then WAIT for the group to
   * actually be gone. Idempotent; concurrent calls share one outcome.
   *
   * Resolves `true` only when the tree's termination has been WITNESSED, and
   * that distinction is the whole point. Delivering a signal is not the same
   * event as a process ending: a descendant can outlive the SIGKILL briefly, or
   * indefinitely in uninterruptible sleep, and a caller that treats the kill as
   * proof releases whatever the tree was holding while it is still running (two
   * narrower fixes to the same path each missed this).
   *
   * `false` means termination could NOT be established: the wait elapsed with
   * the group still present, or the platform offers no way to witness a tree
   * (see `stop`'s implementation). Callers must treat it as "still running".
   */
  stop(): Promise<boolean>;
  /** Resolves once the child has exited and `run()` has settled. */
  readonly exited: Promise<void>;
  /**
   * The child's pid — which, for a detached child, is also its process GROUP
   * id. Exposed so a caller (and the suite) can ask about the group directly
   * rather than inferring its state from this handle's own answers.
   */
  readonly pid: number | undefined;
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
   * bash equivalent of NOT writing `2>/dev/null`, which drive-state's
   * delivery-aware orphan warning depends on — and 'ignore' attaches the null
   * device, which is exactly what a `2>/dev/null` child saw and what its own
   * stderr-goes-nowhere probe must keep seeing.
   */
  stderr?: "pipe" | "inherit" | "ignore";
  /** 'inherit' streams output through (drive.ts's pass command). */
  stdout?: "pipe" | "inherit" | "ignore";
  /**
   * Put the child in its OWN process group even without a deadline, so a
   * `stop()` reaches everything it spawned rather than the one process.
   *
   * A deadlined child already gets this (see `run`); the cost either way is
   * tty signal delivery — a detached child is no longer in the foreground
   * group, so a Ctrl-C at the terminal stops reaching it. Set this only when
   * the caller HANDLES those signals itself and forwards them, which is what
   * makes the trade sound: `drive.ts` installs SIGINT/SIGTERM handlers that
   * stop the pass explicitly, and in exchange the stop reaches `git push` and
   * every other grandchild instead of only the agent process.
   */
  detached?: boolean;
  /** Receives the live child's handle as soon as the spawn succeeds. */
  onSpawn?: (handle: RunHandle) => void;
  /** Overrides `MAX_BUFFER_BYTES` — a test knob, not a per-caller tuning lever. */
  maxBufferBytes?: number;
  /**
   * Test-only: fires once per stdout/stderr chunk with whether it was
   * captured or discarded past the buffer cap.
   */
  onChunk?: (
    stream: "stdout" | "stderr",
    bytes: number,
    captured: boolean,
  ) => void;
}

/**
 * The SIGTERM-to-SIGKILL grace, 2s, through its test pacing seam
 * (`testPacing`). Read per call by `stop()`, so an in-process test can set the
 * seam around the one stop it exercises.
 */
const killEscalateMs = (): number =>
  testPacing("DRIVE_PR_KILL_ESCALATE_MS", 2000, 10);

/**
 * Grace between a SIGTERM and its SIGKILL escalation — shared by `stop()` and
 * `run()`'s own `timeoutSec` handling below, and exported so a caller that
 * needs to reason about how long a deadlined call can actually take to settle
 * (`renew-ready-mark`'s staleness-window validation has to add this on top of
 * `$GH_CALL_TIMEOUT`, since the call does not settle at the deadline — it
 * settles up to this many ms after it) reads the same constant `run()` actually
 * uses rather than a second hand-copied `2000`. Read once, at import, so every
 * bound derived from it agrees with the deadline that waits it.
 */
export const KILL_ESCALATE_MS = killEscalateMs();

/**
 * How long `stop()` waits for the process GROUP to disappear after the
 * SIGKILL, and how often it looks. Generous rather than load-bearing — what is
 * load-bearing is that the wait ENDS and reports `false` rather than assuming.
 */
const STOP_WITNESS_MS = 30_000;
const STOP_WITNESS_POLL_MS = 100;

/**
 * Is process group `pgid` gone?
 *
 * `kill(-pgid, 0)` is the POSIX witness: it delivers nothing and answers only
 * "does any process in that group still exist". ESRCH is the affirmative — no
 * member left. EPERM means a member exists but belongs to another user, which
 * is emphatically NOT gone. Anything else is unreadable, and an unreadable
 * answer is never evidence of termination.
 *
 * The caller's own process is never in this group: `stop()` only witnesses a
 * DETACHED child, which `spawn` made the leader of a fresh group.
 */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * `/proc` root — overridable so a test can point this at a fixture tree
 * instead of the real kernel-maintained one, the same convention the quota
 * adapters use for their own state directories.
 */
function procRoot(): string {
  return process.env.DRIVE_PR_PROC_ROOT ?? "/proc";
}

/**
 * Parse a `/proc/<pid>/stat` line into `{ state, pgrp }`, or `null` if it is
 * not the shape the kernel documents (`proc(5)`): `pid (comm) state ppid
 * pgrp session ...`. `comm` can itself contain spaces and unbalanced
 * parentheses (a process can name itself anything via `PR_SET_NAME` /
 * argv[0]), so the split is anchored on the LAST `)` in the line — never the
 * first — which is the same defensive parse the kernel's own documentation
 * recommends for this exact reason.
 */
function parseProcStat(text: string): { state: string; pgrp: number } | null {
  const closeParen = text.lastIndexOf(")");
  if (closeParen === -1) return null;
  const fields = text
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  // fields[0]=state, fields[1]=ppid, fields[2]=pgrp
  const state = fields[0];
  const pgrp = Number.parseInt(fields[2] ?? "", 10);
  if (state === undefined || !Number.isFinite(pgrp)) return null;
  return { state, pgrp };
}

/**
 * Any LIVE (non-zombie) member of process group `pgid`, read straight from
 * `/proc` — `null` when this process cannot answer at all: no `/proc`
 * (i.e. not Linux) or one this process cannot even list, OR an entry inside
 * it failed to read for a reason OTHER than the pid having exited
 * (ENOENT) — see the loop's own comment for why that distinction is
 * load-bearing rather than defensive.
 *
 * This exists because `groupGone` cannot tell a zombie from a running
 * process: `kill(-pgid, 0)` answers only "does a process-table slot exist
 * for anyone in this group", which a zombie occupies until its parent (or a
 * reaping ancestor) calls `wait` on it. A process spawned under a
 * container PID 1 that does not reap orphans leaves a SIGKILLed
 * descendant a zombie indefinitely — `groupGone` then reports "still
 * alive" for the FULL `STOP_WITNESS_MS` window even though nothing in the
 * group remains capable of editing or pushing. `state !== 'Z'`
 * is the kernel's own answer to "can this pid still act", so trusting it
 * closes the gap without guessing at reaping semantics ourselves.
 *
 * Exported — like `parsePsStatRows` below — so the ENOENT-vs-everything-else
 * distinction can be unit-tested directly against a `DRIVE_PR_PROC_ROOT`
 * fixture, hermetically: a test that instead has to spawn a real process
 * and rely on the `ps` fallback finding it inherits every cross-host
 * variable that dividing line (a different default shell, a different
 * `ps`) can introduce, for a question this function alone can answer.
 */
export function hasLiveGroupMemberLinux(pgid: number): boolean | null {
  let entries: string[];
  try {
    entries = readdirSync(procRoot());
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^[0-9]+$/.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(`${procRoot()}/${name}/stat`, "utf8");
    } catch (e) {
      // ENOENT — the pid exited between `readdirSync` and this read — is the
      // ONLY failure that is safe to skip: a process that is provably gone
      // cannot be the live member this scan is looking for. Anything else
      // (EMFILE, EIO, EACCES, …) means this ENTRY is unreadable for a reason
      // that says nothing about whether it was alive, and every other
      // unanswerable case in this file fails toward "still alive"
      // (`groupGone`'s EPERM branch, an unreadable `procRoot()`, a failed
      // `ps`) — silently `continue`-ing past it here would be the one place
      // that instead treats "cannot tell" as "confirmed gone", which is
      // exactly the false witness this whole function exists to close.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      continue;
    }
    const parsed = parseProcStat(text);
    if (parsed === null || parsed.pgrp !== pgid) continue;
    if (parsed.state !== "Z") return true;
  }
  return false;
}

/**
 * Parse `ps -A -o pid=,pgid=,stat=` output into rows — a pure function so
 * the real vendor-independent parsing can be unit-tested against captured
 * output without spawning `ps`. `stat`'s FIRST character is the POSIX state
 * code (`R`/`S`/`D`/`T`/`Z`/…); GNU and BSD/macOS `ps` both honour the
 * `stat`/`pid`/`pgid` keywords, unlike `state`, which only GNU `ps`
 * recognises.
 */
export function parsePsStatRows(
  output: string,
): Array<{ pid: number; pgid: number; stat: string }> {
  const rows: Array<{ pid: number; pgid: number; stat: string }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0] ?? "", 10);
    const pgid = Number.parseInt(parts[1] ?? "", 10);
    const stat = parts[2] ?? "";
    if (!Number.isFinite(pid) || !Number.isFinite(pgid) || stat === "") {
      continue;
    }
    rows.push({ pid, pgid, stat });
  }
  return rows;
}

/**
 * Any LIVE (non-zombie) member of process group `pgid`, for a POSIX
 * platform with no `/proc` (macOS/BSD) — `null` when `ps` itself is
 * unavailable or fails, so the caller fails toward "still alive" exactly
 * like the Linux path's own `null`.
 */
async function hasLiveGroupMemberPs(pgid: number): Promise<boolean | null> {
  const rows = await processTable();
  if (rows === null) return null;
  for (const row of rows) {
    if (row.pgid !== pgid) continue;
    if (!row.stat.startsWith("Z")) return true;
  }
  return false;
}

/**
 * Any LIVE (non-zombie) member of process group `pgid` — tried via `/proc`
 * first (feature-detected by whether `procRoot()` is readable, never by
 * `process.platform`: a test overriding `DRIVE_PR_PROC_ROOT` to a fixture
 * directory gets the deterministic Linux path on ANY host OS, which is what
 * makes the zombie case testable without spawning a real one), falling back
 * to `ps` only when `/proc` itself could not be read.
 *
 * Windows uses captured creation identities instead of POSIX process groups.
 */
async function hasLiveGroupMember(pgid: number): Promise<boolean | null> {
  const viaProc = hasLiveGroupMemberLinux(pgid);
  if (viaProc !== null) return viaProc;
  return hasLiveGroupMemberPs(pgid);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/*
 * Live children a signal aimed at THIS process can never reach are tracked in
 * the review skill's registry (`registerCancellationGroup`), whose forwarder
 * SIGTERMs, then SIGKILLs, every registered process group when this process
 * is cancelled. A deadlined child is detached (see `run`), which is what lets
 * the deadline kill the whole tree and, by the same token, what stops a
 * signal delivered to this process from reaching it.
 *
 * A child the CALLER detached, or took a `RunHandle` on, is deliberately not
 * registered. Both are that caller declaring it owns this child's
 * cancellation (`RunOptions.detached` says so in as many words), and
 * `drive.ts`'s handler orders its `stop` against the lock release precisely
 * so the pass is witnessed gone before another driver can claim the tree.
 * Forwarding on its behalf would pre-empt that ordering and SIGKILL a
 * mid-edit agent on a 250ms grace instead of the 2s its own stop allows.
 */

/**
 * Spawn `argv` directly — never through a shell — and resolve with its
 * captured output. The deadline, when given, kills the child with SIGTERM,
 * escalates to SIGKILL two seconds later, and then resolves on its own
 * authority rather than waiting for 'close' (see the call site: a surviving
 * grandchild holds the pipes open and would defeat the deadline entirely).
 * Either way the result reports `timedOut` and the conventional 124.
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

function runProcess(argv: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    // A DEADLINED child gets its own process group, so the deadline can kill
    // the whole tree rather than one process. `kill(pid)` reaches the child
    // only; anything it spawned — `git push`'s pre-push hook and the build and
    // test suites under it, `gh`'s helpers — survives, and goes on holding
    // resources and running side effects after this script reports the
    // operation killed.
    //
    // ONLY when a deadline is set, or when the caller asked for it explicitly,
    // and that condition is load-bearing rather than incidental. Detaching
    // costs terminal signal delivery: a Ctrl-C at the tty goes to the
    // foreground process group, so a detached child stops receiving it. An
    // undeadlined child therefore stays in our group and keeps the interrupt —
    // unless its caller has taken over signal delivery itself, which is what
    // `opts.detached` asserts (see the option's own comment, and `drive.ts`'s
    // SIGINT/SIGTERM handlers). Deadlined ones trade the interrupt for a kill
    // that actually reaches the tree, and their deadline is the thing that ends
    // them anyway.
    const detached =
      opts.detached === true ||
      (process.platform !== "win32" && opts.timeoutSec !== undefined);
    const windows = windowsProcessLifecycle(opts.env);
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: traceEnv(windows.env) as NodeJS.ProcessEnv,
      detached,
      windowsHide: true,
      stdio: [
        opts.stdin === undefined ? "ignore" : "pipe",
        opts.stdout ?? "pipe",
        opts.stderr ?? "pipe",
      ],
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd ?? "", args, spawnOpts);
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
    // group THIS library detached on its own initiative, for a deadline: an
    // undetached child still shares our group and gets the terminal's signals
    // directly, and a caller that asked for `detached` or took a `RunHandle`
    // owns its child's cancellation itself (see the registry note above `run`).
    const releaseCancellation = registerRunCancellation(
      child,
      windows,
      detached,
      opts,
    );

    let timedOut = false;
    let spawnFailed = false;
    // Declared out here, not inside the `onSpawn` block, because the 'close'
    // handler below has to read it — a stop's escalation cannot be allowed to
    // die with the leader any more than the deadline's can.
    let stopped = false;
    // Definite-assignment rather than a placeholder: the executor below runs
    // SYNCHRONOUSLY, so the resolver exists before anything can reach this.
    let exitedResolve!: () => void;
    const exited = new Promise<void>((r) => {
      exitedResolve = r;
    });

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
        if (timers.stop) clearTimeout(timers.stop);
        // Untracked here rather than on 'close', because `settle` is also the
        // deadline's own exit path — which fires while the group may still be
        // dying. A stale pgid in the set would have a later cancellation signal
        // a number the kernel has since handed to something else.
        releaseCancellation?.();
        resolve({
          code,
          stdout: output.stdout,
          stderr: output.stderr || (extraErr ?? ""),
          timedOut,
          bufferExceeded: output.bufferExceeded,
          spawnFailed,
          stderrTail:
            code === 0 ? "" : lastBytes(output.tail || (extraErr ?? "")),
        });
        exitedResolve();
      });

    // Signal the whole tree where we can, the child alone where we cannot.
    //
    // POSIX: a negative pid addresses the process GROUP, which `detached`
    // above made the child the leader of — so every descendant that has not
    // called setpgid gets the signal. ESRCH just means the group is already
    // gone; anything else falls back to the single child rather than leaving
    // it running.
    //
    const stillOwned = () =>
      child.exitCode === null && child.signalCode === null;
    const signalTree = (sig: NodeJS.Signals) =>
      windows.signal(child, detached, sig, killEscalateMs());

    // Exposed BEFORE any await, so a caller that must end this child on its own
    // event never races the spawn. `stop` reuses `signalTree`, which is why the
    // escalation to SIGKILL reaches the group rather than the leader alone —
    // for `drive.ts`'s pass that is the difference between ending the agent and
    // ending the `git push` the agent started.
    //
    // `child.pid !== undefined` is the SYNCHRONOUS half of "the spawn
    // succeeded". Node does not throw from `spawn()` for the common failure
    // case — a nonexistent or non-executable command reports ENOENT/EACCES
    // ASYNCHRONOUSLY via the child's 'error' event — but it also never assigns
    // a `pid` for either: confirmed empirically, `child.pid` is `undefined`
    // immediately after `spawn()` returns for both a missing executable and a
    // non-executable file, and a real number immediately for one that actually
    // starts. Calling `opts.onSpawn` unconditionally here, as this line used
    // to, violates this option's own documented contract ("Receives the live
    // child's handle as soon as the spawn succeeds") for exactly the case a
    // caller most needs it to hold: `drive.ts` moved its `pass-spawned`
    // progress stamp into this callback specifically so a missing/invalid pass
    // command would never record an event that did not occur, and an
    // unconditional call here defeated that the moment the failure was
    // asynchronous rather than synchronous. Checking the synchronous `pid`
    // signal — rather than deferring the whole callback to the 'spawn' event —
    // keeps `onSpawn` firing in the SAME tick `run()` is called in for every
    // caller and test that already depends on that timing; only the (rare,
    // always-failing) undefined-pid case changes behavior.
    if (opts.onSpawn && child.pid !== undefined) {
      // Idempotent by memoising the PROMISE, not by an early `return`: two
      // callers must get the same answer, and the second must not be told
      // "already stopped" while the first is still waiting for the witness.
      let stopping: Promise<boolean> | undefined;
      // Cancel the pending backstop SIGKILL once termination is CONFIRMED —
      // never once a signal was merely sent. Left armed unconditionally, it
      // fires the kill grace after a group that was ALREADY gone on the
      // very first check: nothing else clears it in that path (`settle`
      // only clears the timer it finds live at 'close', which already fired
      // and resolved before `doStop` was ever called in this race), so it
      // goes on to SIGKILL a PGID the kernel may since have reassigned to an
      // unrelated process. Only called on a CONFIRMED-gone
      // outcome — an unconfirmed one leaves the timer as the legitimate
      // backstop it already is.
      const clearStopEscalateTimer = (): void => {
        if (timers.stop) {
          clearTimeout(timers.stop);
          delete timers.stop;
        }
      };
      const doStop = async (): Promise<boolean> => {
        stopped = true;
        if (process.platform === "win32") {
          const confirmed = await windows.stop(
            child.pid,
            killEscalateMs(),
            stillOwned,
          );
          if (confirmed) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            settle(1);
          }
          return confirmed;
        }
        signalTree("SIGTERM");
        // The grace, not the guarantee: `settle` clears this timer, and the
        // leader can close while a SIGTERM-ignoring descendant lives on, so
        // 'close' below fires an unconditional group SIGKILL as well.
        const graceMs = killEscalateMs();
        timers.stop = setTimeout(() => signalTree("SIGKILL"), graceMs);
        const pgid = child.pid;
        if (!detached || pgid === undefined) {
          // No group to witness. A non-detached child shares OUR group, so
          // `kill(-pgid, 0)` would answer about this process. The best
          // available answer is the direct child's own exit, and the caller
          // is told plainly that the TREE was not witnessed.
          await exited;
          return false;
        }
        // Wait out the grace by watching for the group to go on its own — a
        // pass that exits promptly on SIGTERM should not be made to wait for
        // an escalation it never needed.
        const deadline = Date.now() + graceMs + STOP_WITNESS_MS;
        // Throttled to roughly once a second, independent of the 100ms
        // `groupGone()` poll: the zombie case does not change from one tick
        // to the next, and running `hasLiveGroupMember`'s heavier check
        // (a `readdirSync` over every pid, or a spawned `ps` on
        // macOS/BSD) every 100ms would cost up to ~300 subprocess spawns
        // over the FULL window for the ordinary "still genuinely running"
        // case — which is most of them, since the zombie case is the
        // exception this exists to shortcut, not the common shape of the
        // wait. `0` guarantees the FIRST iteration still checks immediately
        // rather than waiting out the first throttle interval.
        const LIVE_CHECK_THROTTLE_MS = 1000;
        let lastLiveCheckAt = 0;
        for (;;) {
          if (groupGone(pgid)) {
            clearStopEscalateTimer();
            return true;
          }
          const now = Date.now();
          if (now - lastLiveCheckAt >= LIVE_CHECK_THROTTLE_MS) {
            lastLiveCheckAt = now;
            // A process-table slot still exists for the group, but that
            // alone does not mean anything capable of editing or pushing
            // remains — see `hasLiveGroupMember`'s own doc comment for the
            // zombie case this closes. `null` (the probe itself
            // could not run) fails toward "still alive", the same posture
            // `groupGone`'s own EPERM branch already takes for an
            // unanswerable question.
            if ((await hasLiveGroupMember(pgid)) === false) {
              clearStopEscalateTimer();
              return true;
            }
          }
          if (Date.now() >= deadline) return false;
          await sleep(STOP_WITNESS_POLL_MS);
        }
      };
      opts.onSpawn({
        exited,
        pid: child.pid,
        stop: () => {
          stopping ??= doStop();
          return stopping;
        },
      });
    }

    if (opts.timeoutSec !== undefined) {
      timers.kill = setTimeout(() => {
        timedOut = true;
        signalTree("SIGTERM");
        timers.escalate = setTimeout(() => {
          signalTree("SIGKILL");
          // Settle on the DEADLINE's terms, not on 'close'.
          //
          // 'close' waits for the stdio streams as well as the exit, and every
          // descendant inherited those streams — so it does not fire while any
          // of them lives, and the deadline that just fired would go on waiting
          // for a grandchild. That is the very hang this timer exists to bound,
          // so it must not be reachable through it. Measured, not theorised: a
          // stubbed `git push` whose bash wrapper ran `sleep 10` under a 1s
          // deadline settled after ten seconds until this line existed.
          //
          // The group kill above makes that case rare, not impossible, which is
          // why this stays rather than being replaced by it: a descendant that
          // called setpgid has left the group, a non-detached fallback reaches
          // only the child, and Windows `taskkill` is spawned fire-and-forget.
          // Each leaves a live handle on the pipes. The kill is the remedy; this
          // is the guarantee.
          //
          // Destroying our ends of the pipes is what lets the runtime exit
          // afterwards — an orphaned grandchild holding a live handle would
          // otherwise keep the event loop alive past the resolved promise.
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          settle(124);
        }, KILL_ESCALATE_MS);
      }, opts.timeoutSec * 1000);
    }

    // Set BEFORE `settle`, exactly as `timedOut` and `output.bufferExceeded` are, so
    // the flag is on the result this handler produces.
    //
    // Node emits 'error' for a handful of causes, and a failed spawn is only
    // the first: a kill that could not be delivered can raise it too, AFTER a
    // child really ran. That mislabels nothing that matters — `settle` is
    // idempotent, so a post-exit 'error' never reaches here, and the residual
    // case would make `converge.ts` DECLINE to release a lease it could have,
    // which is the harmless direction (the record expires by staleness, the
    // older behaviour). The dangerous direction is the reverse, and
    // this flag exists to close it.
    child.on("error", (e) => {
      spawnFailed = true;
      settle(127, e.message);
    });
    child.on("close", (code) => {
      // A timed-out child that exits on SIGTERM cancels its own escalation:
      // `settle` clears `timers.escalate`, so if 'close' fires before the two
      // seconds elapse — which it does whenever the surviving descendants are
      // not holding the captured streams — the group SIGKILL never happens and
      // the tree leaks anyway, while this wrapper reports 124. So the kill
      // moves here, where it cannot be raced.
      //
      // Immediately, rather than by keeping the timer alive: once `settle`
      // resolves, the caller runs and typically ends the process (`fail` exits),
      // which would take a pending timer with it — a grace period that only
      // sometimes elapses is not a grace period, and losing the kill is the
      // failure being fixed. The group already took SIGTERM at the deadline; the
      // grace it got is however long the leader took to die.
      //
      // A `stop()` needs exactly the same treatment, and for exactly the same
      // reason — it was missed when `stop()` was added and reported one round
      // later. The leader can exit
      // on the stop's SIGTERM while a descendant that IGNORES SIGTERM keeps
      // running; 'close' then fires, `settle` clears `timers.stop`, the
      // scheduled group SIGKILL never happens, and `exited` resolves — telling
      // `drive.ts` the pass is gone so it releases both locks with that
      // descendant still editing and pushing. Killing the group here instead of
      // relying on the timer is what makes it unraceable.
      //
      // `output.bufferExceeded` gets the same treatment for the same reason: its own
      // escalation timer is exactly as raceable against a leader that exits
      // promptly on the SIGTERM it sent.
      if (timedOut || stopped || output.bufferExceeded) signalTree("SIGKILL");
      settle(timedOut ? 124 : output.bufferExceeded ? 1 : (code ?? 1));
    });

    writeChildInput(child.stdin, opts.stdin);
  });
}

/**
 * `gh` with the GH_CALL_TIMEOUT deadline — the `gh_call` of the bash lib.
 *
 * `timeoutSec` is an optional TIGHTENING, never a loosening: a caller that
 * holds a budget smaller than `GH_CALL_TIMEOUT` (drive-status.ts's poll loop
 * owns `--timeout`, which is independent of the env default) can pass it, and
 * the effective deadline is whichever is smaller. Omitting it keeps the env
 * default exactly as before.
 *
 * It lives here rather than at the call site because `run(['gh', …])` is a raw
 * spawn, and this skill has a guardrail test asserting that every outbound `gh`
 * call routes through this chokepoint — so clamping by dropping to `run` would
 * trade one fix for a regression of that guard (which the test catches).
 */
export const ghCall = traceGhRunner<RunResult, RunOptions>(
  (args, opts) => run(["gh", ...args], opts),
  ghCallTimeoutSeconds,
  {},
);

/**
 * `git`. Undeadlined BY DEFAULT, because every call in this skill but one is
 * local (`rev-parse`, `merge-base`, `cat-file`, `status`) and cannot hang on a
 * network the way `gh` can — which is why `ghCall` carries a deadline and this
 * does not.
 *
 * The exception is `guarded-push.ts`'s `git push`, the only call here that
 * talks to a REMOTE, and it passes its own `timeoutSec`. A caller adding
 * another remote-facing subcommand (`fetch`, `ls-remote`, `clone`) must do the
 * same: unbounded, they are mode 13 in references/terminal-states.md — a
 * connection accepted and never completed parks an unattended driver past
 * every advertised deadline.
 */
export function git(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(["git", ...args], opts);
}

/**
 * Is there an UNCONCLUDED merge, cherry-pick, revert, rebase, or `git am`
 * sitting in this worktree's git directory? `git status --porcelain` — even
 * with an explicit untracked-files mode and `--ignore-submodules=none` —
 * answers "is anything uncommitted", not "is a git operation still open":
 * resolving a conflict back to a tree that matches what was already committed
 * (`git checkout --ours f && git add f`, say) leaves `MERGE_HEAD` behind while
 * porcelain status reports empty. An interactive rebase paused at an `edit`
 * instruction, or a `git am` mid-apply, can likewise leave a clean
 * index/worktree while `rebase-merge`/`rebase-apply` remain — both checked here
 * too.
 *
 * The git-dir resolution runs through `git()` itself (already bounded, already
 * cross-platform — the same `git rev-parse` every other call in this file
 * uses). The marker CHECK is where a synchronous `existsSync()` in THIS process
 * would have no deadline or cancellation of its own — on a stalled filesystem
 * it would hang indefinitely regardless of `GIT_CALL_TIMEOUT`, and the caller's
 * documented fail-closed refusal would never be reached. An earlier version
 * folded the whole probe (git-dir resolution AND marker check) into one `sh -c`
 * script to get both under `run()`'s timeout-and-kill machinery in a single
 * subprocess — but that reintroduces exactly the POSIX-shell dependency this
 * file's own header explains this port exists to avoid: on Windows with no `sh`
 * on PATH, every converged `drive.ts` run would exit 12 and every announcement
 * would refuse, even over a clean repository. The marker check instead runs as
 * a SEPARATE bounded subprocess — `process.execPath` (bun under bun, node under
 * node, same convention `tsArgv()` uses) with an inline `-e` script that does
 * nothing but `existsSync()` in a CHILD process, so `run()`'s existing
 * timeout-and-kill can bound it exactly like every other call here, without a
 * shell of any kind.
 *
 * `ok: false` means either probe could not complete (an unresolvable
 * git-dir, a timeout, an unreadable filesystem) — fail-closed, the same
 * posture the caller's own unreadable-tree branch already takes, rather than
 * silently treating "cannot confirm" as "confirmed none". `marker` names the
 * offending file/directory's basename, or is `null` when none is present.
 *
 * `opts.cwd`/`opts.env` are for a caller that has already anchored a
 * `root`/sanitized environment of its own (base-sync.ts's — a leaked
 * `GIT_DIR` overrides repository discovery regardless of cwd, so the
 * `--git-dir` read needs the same sanitized env every other call in that
 * caller gets) and needs THIS probe to answer for that same checkout rather
 * than the ambient one. `opts.cwd` is forwarded to the marker-probe
 * subprocess too, not just the `rev-parse` call: `--git-dir` can answer with
 * a path RELATIVE to the directory it was run in, and the probe subprocess
 * would otherwise resolve that relative path against ITS OWN default cwd —
 * this process's, not the caller's — silently checking the wrong directory
 * whenever the two differ. Every existing caller omits both and keeps
 * reading the ambient cwd/env exactly as before.
 */
const UNCONCLUDED_GIT_OP_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

/**
 * `process.argv.slice(1)` under a bare `bun -e <script>` is exactly the
 * trailing argv this is invoked with (no `eval`/script-path placeholder
 * occupies a slot) — verified empirically.
 */
const MARKER_PROBE_SCRIPT = `
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const [gitDir, ...markers] = process.argv.slice(1);
for (const m of markers) {
  if (existsSync(join(gitDir, m))) {
    process.stdout.write(m);
    process.exit(0);
  }
}
process.exit(0);
`;

export async function unconcludedGitOpMarker(
  timeoutSec: number,
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ ok: true; marker: string | null } | { ok: false }> {
  const dirRes = await git(["rev-parse", "--git-dir"], {
    stderr: "ignore",
    timeoutSec,
    cwd: opts?.cwd,
    env: opts?.env,
  });
  if (dirRes.code !== 0) return { ok: false };
  const gitDir = dirRes.stdout.trim();
  if (gitDir === "") return { ok: false };

  const probe = await run(
    [
      process.execPath,
      "-e",
      MARKER_PROBE_SCRIPT,
      gitDir,
      ...UNCONCLUDED_GIT_OP_MARKERS,
    ],
    { stderr: "ignore", timeoutSec, cwd: opts?.cwd },
  );
  if (probe.code !== 0) return { ok: false };
  const marker = probe.stdout.trim();
  return { ok: true, marker: marker === "" ? null : marker };
}

/**
 * Argv for a sibling `.ts` script, run under the SAME Bun binary executing
 * this one (`process.execPath`) — the cross-platform replacement for relying
 * on a `#!/usr/bin/env bun` shebang, which Windows cannot honour.
 */
export function tsArgv(scriptPath: string, args: string[] = []): string[] {
  return [process.execPath, scriptPath, ...args];
}

/**
 * Resolve the PR number: an explicit argument wins; otherwise ask `gh` for
 * the current branch's PR. Returns '' when neither yields one — each caller
 * owns its own refusal message, as the bash scripts did.
 *
 * `cwd` is optional and defaults to unset (the process's own ambient cwd) —
 * correct for every caller here but one. `self-inflicted.ts` is the
 * exception: it accepts a `--repo`/`$DRIVE_PR_WORKTREE` naming a DIFFERENT
 * checkout than the process cwd, and `gh pr view` with no cwd override reads
 * the branch and remote of whichever repository the process happens to be
 * running in, not `repo` — leaving an omitted PR unresolvable, or worse,
 * resolving one that also exists in the ambient repository against the
 * WRONG base.
 *
 * `cwd` alone is not sufficient to anchor `gh` there: `gh` gives `GH_REPO`
 * precedence over local repository discovery even when `cwd` names a
 * perfectly good checkout, so an inherited `GH_REPO` from the ambient
 * environment can resolve this call against a THIRD repository — neither the
 * process's ambient one nor the one at `cwd`. A
 * `cwd`-bound call therefore also runs with `ghRepoEnv()`, mirroring
 * `gitIdentityEnv()`'s reasoning for `git`.
 */
export async function resolvePr(
  explicit: string,
  cwd?: string,
): Promise<string> {
  if (explicit !== "") return explicit;
  const r = await ghCall(["pr", "view", "--json", "number", "-q", ".number"], {
    stderr: "ignore",
    ...(cwd === undefined ? {} : { cwd, env: ghRepoEnv() }),
  });
  if (r.code !== 0) return "";
  return r.stdout.trim();
}

/**
 * Is the recorded pid alive?
 *
 * A pid from ANOTHER HOST is unanswerable — `process.kill(pid, 0)` would report
 * on an unrelated local process that happens to share the number — so it counts
 * as alive. Fail-closed on purpose, and both callers pay the same price for it:
 * the cost of guessing "alive" is a refusal a human clears in one command, and
 * the cost of guessing the other way is two concurrent drivers (or, for
 * `drive.ts`'s staging sweep, destroying a foreign host's live directory).
 *
 * Shared by BOTH of this skill's owner-liveness protocols — `drive.ts`'s
 * single-instance locks and `lib/state/lease.ts`'s session lease — rather than
 * copied into each, for the reason `store.ts`'s `worktreeLockName` gives about
 * its own shared derivation: two copies of a liveness test that could drift
 * would let the two protocols disagree about whether the same process is
 * running, and each would then be relying on a guarantee the other had stopped
 * providing.
 *
 * A live pid is never on its own proof that the OWNER lives: after a process
 * dies the OS may hand its number to an unrelated long-lived one. Both callers
 * pair this with a renewal window of their own — `drive.ts`'s heartbeat, the
 * lease's `lastSeen` — and neither may use it alone.
 */
export function pidAlive(pid: number, host: string): boolean {
  if (host !== "" && host !== hostname()) return true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM means the pid exists but belongs to another user — alive.
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return true;
}

/**
 * The command a human should run to check whether `pid` is still alive, for the
 * platform they are standing on.
 *
 * Part of the exit-11 refusal contract: the lease refusals name a liveness
 * check as the way to decide whether to override, so an instruction the reader
 * cannot execute makes the refusal unrecoverable in practice. These scripts
 * support Windows deliberately (no coreutils), where `ps` is
 * not normally present — so the command is selected rather than hardcoded.
 *
 * `host` decides whose machine it runs ON; `platform` decides the syntax. The
 * writer of a lease knows its own platform, so it records it and this reads it
 * back — rather than inferring a REMOTE host's from the local one, which would
 * hand a Windows holder's `ssh <host> ps -p <pid>` to an operator on a machine
 * with no `ps`.
 *
 * `platform` is optional because not every caller has one to offer, and an
 * unknown platform is answered honestly rather than guessed: for a remote host
 * it returns null, and callers say so in words instead of printing a command
 * that may not run. Locally there is nothing to guess — `process.platform` is
 * the answer.
 */
export function pidCheckCommand(
  pid: number,
  host: string,
  platform?: string,
): string | null {
  const remote = host !== "" && host !== hostname();
  const target = remote ? platform : process.platform;
  if (target === undefined || target === "") return null;
  const check = target === "win32" ? `Get-Process -Id ${pid}` : `ps -p ${pid}`;
  return remote ? `ssh ${host} ${check}` : check;
}

/**
 * Every environment variable that overrides git's own `cwd`-based repository
 * discovery. Any of these exported into this process — a lefthook hook exports
 * `GIT_DIR` and `GIT_WORK_TREE` together, but nothing guarantees only that
 * shape reaches here — silently redirects a `cwd`-anchored `git` call at a
 * DIFFERENT repository than the caller is reasoning about.
 *
 * `GIT_DIR` alone, with no `GIT_WORK_TREE`, is the sharpest case: git then
 * treats the CURRENT DIRECTORY as the work tree while resolving refs from the
 * leaked dir, so `rev-parse --show-toplevel` reports `cwd` — matching whatever
 * anchor a caller checks it against — while `rev-parse HEAD` answers for
 * another repository entirely. `cwd` alone was never sufficient against any of
 * these. `GIT_NAMESPACE` is the same hazard through ref resolution
 * (`refs/namespaces/<ns>/…`) without touching which worktree is reported.
 *
 * ONE list and ONE scrubber, here, rather than a copy per entrypoint. Three
 * copies existed and had already drifted: only drive-status.ts's carried
 * `GIT_NAMESPACE` and the Windows case-folding below, so the other two were
 * strictly weaker against hazards that had been found and fixed once. A
 * measured-and-fixed leak that survives in a sibling copy is the defect, not
 * the duplication.
 */
export const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
];

/**
 * `process.env` with every entry in `GIT_LOCATION_VARS` removed — pass as
 * `env:` to any `cwd`-anchored `git` call whose answer must be about the
 * repository at that `cwd`.
 *
 * Windows environment-variable names are case-INSENSITIVE, but a JS object's
 * property deletion is not: an inherited spelling like `Git_Dir` survives an
 * exact-match delete and is still read by git as `GIT_DIR`, reopening the leak
 * this exists to close. POSIX
 * names ARE case-sensitive, so the exact-match form stays correct and cheaper
 * there.
 */
export function gitIdentityEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  if (process.platform === "win32") {
    const targets = new Set(GIT_LOCATION_VARS.map((k) => k.toLowerCase()));
    for (const key of Object.keys(env)) {
      if (targets.has(key.toLowerCase())) delete env[key];
    }
  } else {
    for (const key of GIT_LOCATION_VARS) delete env[key];
  }
  return env;
}

/**
 * `process.env` with `GH_REPO` removed — the `gh` CLI's equivalent of `GIT_DIR`
 * above: `gh` gives `GH_REPO` precedence over the repository it would otherwise
 * detect from the current directory, ahead even of an explicit `cwd`. Pass as
 * `env:` to any `cwd`-anchored `gh` call whose answer must be about the
 * repository AT that `cwd` — an inherited `GH_REPO` from the ambient
 * environment would otherwise silently redirect it to a different repository
 * regardless of `cwd`. `GH_HOST` is left alone: it selects which host's
 * credentials to use, never which repository, so it carries none of this
 * hazard.
 *
 * Windows environment-variable names are case-insensitive (`gitIdentityEnv()`
 * above documents the same trap), so an exact-match delete leaves an inherited
 * `Gh_Repo` in place there, still honored by `gh`.
 */
export function ghRepoEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "gh_repo") delete env[key];
    }
  } else {
    delete env.GH_REPO;
  }
  return env;
}
