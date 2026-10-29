/** Dispatch bounded repair passes and record quota parking with the same ownership controls as review passes. */
import {
  type RepairTask,
  type RepairDispatch,
  passTimeoutSeconds,
  SINGLE_INSTANCE_LOCK_EXIT,
} from "./settings.ts";

import type { DriveLock } from "./locks.ts";

import { refreshAccountIdentityBeforeSpawn } from "./identity.ts";

import { driverRuntime } from "./runtime.ts";

import { span } from "./../../../../../shared/trace.ts";

import { run, tsArgv, helperTimeoutSeconds } from "./../proc.ts";

import { finishDriverPassRegistrations, touchLock } from "./lifecycle.ts";

// `drive.ts` is itself very often launched from inside a live Claude Code
// session (do-item's "Arm the drive" step spawns it in the background), and
// a spawned child inherits that session's env by default — including
// CLAUDECODE, which the `claude` CLI sets to recognize a nested invocation of
// itself. Passed through unchanged to a `claude -p` pass command, that marker
// makes the pass refuse to start as a nested session — silently, after this
// process has already reported the round as running. The pass is a fresh
// top-level session, not a continuation of whatever spawned `drive.ts`, so it
// must not inherit that marker.
export function passEnv(task?: {
  task: RepairTask;
  detail: string;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // DELETED UNCONDITIONALLY FIRST, then set only for a repair pass. An
  // ordinary review round must never inherit a repair task — not from this
  // driver's own environment, and not from an operator who exported one by
  // hand to reproduce something. A review pass that believed it was a
  // CI-repair round would skip triage entirely and leave live findings
  // unanswered, which is the one failure this whole loop exists to prevent.
  delete env.DRIVE_PR_ROUND_TASK;
  delete env.DRIVE_PR_ROUND_TASK_DETAIL;
  // The same for the notice of a recovered stop: only the driver that
  // recovered it may say so, and only to the review pass it spawns next.
  delete env.DRIVE_PR_PASS_NOTICE;
  if (task !== undefined) {
    env.DRIVE_PR_ROUND_TASK = task.task;
    env.DRIVE_PR_ROUND_TASK_DETAIL = task.detail;
  }
  return env;
}

/**
 * Spawn one repair pass and return its exit code.
 *
 * The RAW code, not a collapsed boolean: `guarded-push.ts` exits `5` for
 * `PR_NOT_OPEN` inside the pass, exactly like the ordinary-pass ROUND_READY
 * spawn does, and a caller that only learns "zero or nonzero" cannot tell
 * that apart from an ordinary repair failure — reporting a CI stop or a
 * conflict stop over a PR that already merged or closed, which
 * `passExitDisposition` exists precisely to prevent for the ordinary path.
 * Callers check `=== 5` themselves, mirroring `passExitDisposition`'s own
 * handling rather than duplicating it inside this shared helper.
 *
 * DELIBERATELY NOT the ROUND_READY spawn block. That block carries a review
 * round's whole accounting: the durable round/attempt bumps, the pre-pass
 * Ready record, the stall fingerprint, `--max-rounds`, the reflect-due
 * handoff. None of it describes a repair, and threading a second mode through
 * it would put a conditional on every one of those steps — the shape that
 * makes a state machine unreadable, on the file `references/consistency.md` already names as the
 * highest-churn.
 *
 * What it therefore does NOT get, stated rather than discovered later:
 *
 *   - NO QUOTA HANDLING. A repair pass that dies on a subscription wall is
 *     an ordinary failed pass here, and the caller falls back to the stop it
 *     would have taken anyway. It does not park the drive. That is a bounded
 *     degradation of a path that previously did not exist at all, never a
 *     regression of the quota handling a REVIEW round still gets in full.
 *   - NO DURABLE ROUND ACCOUNTING. A repair is bounded by its in-memory
 *     budget, not by `--max-rounds`; see `ciRepairRounds`'s header.
 *
 * What it does share, because those are about the process tree rather than
 * the round: `detached` so a stop reaches the whole pass tree, `activePass`
 * so the signal handlers can find it, the pass deadline, and a lock touch on
 * the way out.
 */
export async function runRepairPass(
  // `string[]`, not `readonly string[]`: `run()`'s own argv parameter is
  // mutable, and widening here would only move the variance error to the call.
  agent: string[],
  // Mutable: the unwitnessed-deadline branch below needs to clear this array
  // in place, the same way the ordinary-pass path clears `held` — see that
  // branch's own comment for why.
  locks: DriveLock[],
  task: RepairTask,
  detail: string,
  // The caller's own checkpoint closure (§ mailboxCheckpoint in `main()`).
  // Passed in rather than re-created here: it closes over `mailboxDir`, `pr`
  // and `pauseMaxSec`, all local to `main()`, and re-checking through the
  // SAME closure keeps this function's own re-check indistinguishable from
  // every other call site's (see this function's own pre-spawn re-check
  // below for why one is needed here at all).
  mailboxCheckpoint: () => Promise<"clear" | "resumed" | number>,
): Promise<RepairDispatch> {
  const deadlineSec = passTimeoutSeconds();
  // One more refresh, immediately before THIS spawn — not only at the PRIOR
  // pass's exit, below: the only other call in this function ran AFTER
  // `run()` returned, so the very FIRST repair pass of a drive got no
  // pre-spawn read at all — a file-backed login change landing between
  // dispatch and this spawn stayed stale for that pass's whole life, while
  // active-pass gating suppressed the heartbeat's own retries throughout.
  // Same pattern as the ordinary-pass spawn site's own pre-spawn call.
  const preSpawnSynced = await refreshAccountIdentityBeforeSpawn(locks, agent);
  if (driverRuntime.compromised !== "") {
    console.error(
      `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver — not starting a repair pass.`,
    );
    return {
      dispatched: false,
      resumed: false,
      code: SINGLE_INSTANCE_LOCK_EXIT,
    };
  }
  if (!preSpawnSynced) {
    console.error(
      "  the account-identity claim rewrite did not land before the repair pass — proceeding with a possibly-stale display; the heartbeat retries once this pass exits.",
    );
  }
  // Re-checked HERE, after the identity refresh above, not only by the
  // caller before this function was invoked: that refresh is itself an await
  // a mailbox directive can land during, so the caller's own pre-dispatch
  // checkpoint does not cover the gap between it and this spawn — this call
  // is what makes THIS spawn's own checkpoint the LAST await before `run()`,
  // matching the ordinary-pass site's invariant. Its outcome is tagged
  // `dispatched: false` so a caller can never mistake it for the pass's OWN
  // exit code below.
  const mailboxBeforeSpawn = await mailboxCheckpoint();
  if (typeof mailboxBeforeSpawn === "number")
    return { dispatched: false, resumed: false, code: mailboxBeforeSpawn };
  if (mailboxBeforeSpawn === "resumed")
    return { dispatched: false, resumed: true };
  const res = await span("pass", { kind: "repair" }, () =>
    run(agent, {
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
      env: passEnv({ task, detail }),
      ...(deadlineSec > 0 ? { timeoutSec: deadlineSec } : {}),
      onSpawn: (h) => {
        driverRuntime.activePass = h;
      },
    }),
  );
  // Captured before `activePass` is cleared, same as the ordinary-pass
  // path's own `passHandle` — see its comment for why this has to happen
  // here rather than reading `activePass` again below.
  const handle = driverRuntime.activePass;
  const registrationsDone = await finishDriverPassRegistrations(locks);
  driverRuntime.activePass = null;
  if (!registrationsDone)
    return { dispatched: true, code: 1, postPassMailboxExit: null };
  // Mirror the ordinary-pass path's PASS_DEADLINE handling: `run` resolving
  // once its own SIGKILL escalation FIRES is proof a signal was SENT, not
  // that the process group is actually GONE — a descendant in
  // uninterruptible sleep, or one that escaped the group, can outlive it.
  // Re-poll the same witnessed-termination check before this driver's own
  // exit handler releases its locks: a live repair descendant under a
  // released lock is the exact two-drivers-one-tree state those locks exist
  // to prevent. The ordinary path does this via `passHandle.stop()`
  // re-joining the same memoised wait `RunHandle.stop()` performs; this is
  // that same call.
  if (res.timedOut && handle !== null && !(await handle.stop())) {
    console.error(
      "  the repair pass hit its deadline and its termination could NOT be witnessed — some descendant may still be running.",
    );
    console.error(
      "  NOT releasing this drive's locks: a live pass under a released lock is the",
    );
    console.error(
      "  exact two-drivers-one-tree state they exist to prevent. Confirm the tree is",
    );
    console.error("  actually gone, then remove the lock dir to re-arm.");
    locks.length = 0;
    // No post-pass checkpoint here: termination could not be witnessed, so
    // a descendant may still be running — this return must stay quick
    // rather than risk blocking on a pause wait against a tree in that
    // state.
    return { dispatched: true, code: res.code, postPassMailboxExit: null };
  }
  for (const lock of locks) touchLock(lock);
  // Mirror the ordinary-pass path's post-pass refresh, bounded retry
  // included: `activePass` is already `null` (above), which is the exact
  // window a file-backed login change during THIS repair pass needs closed
  // before the next spawn — the CI-repair budget (default 2) lets the loop
  // re-gate and dispatch a second repair pass well inside one heartbeat
  // interval, same as the ordinary path's own back-to-back-spawn risk. A
  // bare, unretried call here left a merely-transient rewrite failure
  // unretried right up to that next spawn — see
  // `refreshAccountIdentityBeforeSpawn`'s own header. Its `compromised` side
  // effect is picked up by both call sites' existing
  // `if (compromised !== '')` check immediately after this returns —
  // there is nothing further to do with it here.
  const identitySynced = await refreshAccountIdentityBeforeSpawn(locks, agent);
  if (driverRuntime.compromised === "" && !identitySynced) {
    // Not a takeover — an ordinary, still-unresolved transient failure
    // after every retry. Proceeding anyway, same posture as the
    // ordinary-pass spawn: the heartbeat resumes retrying once this repair
    // pass's caller reaches its own next tick, and a repair pass must not
    // stall over a DISPLAY value.
    console.error(
      "  the account-identity claim rewrite did not land after the repair pass — proceeding with a possibly-stale display; the heartbeat retries before the next spawn.",
    );
  }
  // A directive sent WHILE this repair pass ran must still be honored before
  // its result is reported — the same gap the ordinary-pass path had at its
  // own post-pass point. `clear`/`resumed` both leave `postPassMailboxExit`
  // null: the pass already ran, so the caller reports its real result either
  // way, once it has committed the budget this confirmed dispatch earned.
  const mailboxAfterRepairPass = await mailboxCheckpoint();
  return {
    dispatched: true,
    code: res.code,
    postPassMailboxExit:
      typeof mailboxAfterRepairPass === "number"
        ? mailboxAfterRepairPass
        : null,
  };
}

/**
 * Record the quota wall this drive is parking on.
 *
 * Called on BOTH quota paths, which is the whole point: the `stop` path
 * exits and lets the claim age toward `stale`, while the `sleep` path holds
 * its locks and keeps refreshing them for up to `maxSleepMs` (six hours by
 * default) with no pass running and no progress to stamp. Without a record,
 * `--doctor` reads that second case as a live driver with hours-stale
 * progress and no pass child — the exact shape of `WEDGED` — and reports a
 * drive that is doing precisely what it was designed to do as stuck.
 * `QUOTA_PARKED` outranks `WEDGED` in `lib/doctor.ts`'s precedence order, so
 * recording it here is what makes the sleeping case classify honestly.
 *
 * Best-effort by design: a failure to record must not fail the wall handling
 * itself. Losing the record costs a `--doctor` verdict — `WEDGED` on the
 * sleeping path, `UNKNOWN` on the exiting one — never a false `HEALTHY`, and
 * never the drive.
 */
export async function recordQuotaPark(
  driveStatePath: string,
  pr: string,
  block: { vendor: string; window: string; resetAt: Date | null },
  account: string | null,
): Promise<void> {
  const park = await run(
    tsArgv(driveStatePath, [
      "quota-park",
      pr,
      "--vendor",
      block.vendor,
      "--window",
      block.window,
      ...(block.resetAt !== null
        ? ["--reset-at", block.resetAt.toISOString()]
        : []),
      // Whose wall it is: a re-arm from another account may pass it.
      ...(account !== null ? ["--account", account] : []),
    ]),
    // Deadlined per `references/consistency.md` — on the exiting
    // path an undeadlined hang would hold the drive's locks open
    // indefinitely at the one moment whose whole job is to release them.
    { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  if (park.code !== 0) {
    console.error(
      `drive.ts: could not record the quota park for PR #${pr} (drive-state.ts exited ${park.code}) — continuing anyway.`,
    );
  }
}
