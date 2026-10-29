#!/usr/bin/env bun
/**
 * Drive review rounds on one PR until it reaches exactly one terminal state.
 *
 * The loop BODY has to be an agent — something must read each finding and
 * choose an outcome. The loop CONTROL does not, and keeping it here is what
 * lets the drive run unattended from any harness: each round is a fresh agent
 * process, so a long converge never depends on one session's context
 * surviving.
 *
 * Usage:
 *   drive.ts [PR] [flags] -- <command to run ONE pass> [args...]
 *
 *   --max-rounds N   stop after N rounds (default `drive.max_rounds`, else
 *                    10). A finding the agent cannot fix would otherwise
 *                    re-push forever.
 *   --handoff-at V   the context-economy dial: hand off at V% of the pass's
 *                    context rather than degrading. V is a whole percent, or
 *                    `never` for a continuous drive through compaction.
 *                    Aliases: `careful` (50, the default), `eager` (75),
 *                    `continuous` (never). Exported to the pass as
 *                    $DRIVE_PR_HANDOFF_AT. This one is AGENT-JUDGED, not
 *                    measured — see below.
 *   --bots-only      count only bot-authored threads (pass it to the agent
 *                    too).
 *   --keep-draft     do NOT mark a draft PR Ready for review at all; the same
 *                    as `pull_requests.mark_ready: never` for this run. When
 *                    the drive marks a draft Ready is otherwise
 *                    `pull_requests.mark_ready`: after round N (default 1),
 *                    or only at convergence. Off by default: repo policy births
 *                    every PR as a draft, the configured AI reviewer reviews
 *                    drafts but CodeRabbit refuses them, so the drive clears
 *                    the AI reviewer's findings and THEN marks the PR Ready,
 *                    spending the paid external reviewer's one pass on an
 *                    already-cleaned head.
 *                    See mark-ready.ts for the measurements.
 *   --timeout S      forwarded to drive-status.ts.
 *   --interval S     forwarded to drive-status.ts.
 *   --no-head-sync   forwarded to drive-status.ts.
 *
 * There is deliberately no `--head`: drive.ts DRIVES THE TREE IT RUNS IN. Its
 * worktree lock is keyed on that tree, its pass edits and pushes that tree, and
 * its convergence certification (`rev-parse HEAD`, the operation markers,
 * `git status`) reads that tree — so a flag pointing the head COMPARISON
 * somewhere else could only ever describe a repository nothing else in this
 * file touches. A briefly-forwarded `--head` was all three reviewers' finding
 * in one round: frozen at startup, it wedges the head-sync guard in
 * HEAD_LAG the moment a pass pushes; being a caller's assertion at one instant
 * rather than a continuing measurement, it cannot attest sameness for the stall
 * stop either; and it left the convergence certification reading the driver's
 * own unrelated checkout. `$DRIVE_PR_WORKTREE` is the mechanism that survived:
 * drive.ts exports the tree it drives and drive-status.ts RE-MEASURES there at
 * every gate. `drive-status.ts --head` remains, for a single-shot probe where
 * one instant is all that is claimed.
 *   --dry-run        report each round's decision; never invoke the pass.
 *   --take-over      replace the driver holding this PR's lock when
 *                    `drives.ts --doctor` calls it WEDGED (it is stopped
 *                    through `drives.ts --stop`), or when its process is gone
 *                    and its tree holds nothing unpushed; refused with 11
 *                    against any other holder (`lib/driver/takeover.ts`).
 *   --window-reopened  a person's statement that a quota-parked drive's
 *                    window is open again: admits the re-arm on any account
 *                    (`lib/driver/rearm.ts`).
 *
 * The pass command is given as ARGV after `--`, and is executed directly —
 * with Windows batch shims adapted through cmd.exe by the process runner.
 * An opaque command string run through a shell would
 * have to be proven, by walking it character by character tracking quote state,
 * to name the right PR in every `;`/`&&`/`||`/`|`-separated segment — because a
 * pass that silently targets the current branch's PR edits and resolves threads
 * on the wrong pull request. Taking argv removes the shell layer, so there are
 * no segments to prove anything about and the guard below is an exact token
 * test (resolve-review-comments' converge.ts takes the same interface for the
 * same reason).
 *
 *   bun drive.ts 123 --bots-only -- claude -p "/jig:drive-pr --bots-only 123"
 *
 * Exit codes mirror drive-status.ts, plus 6:
 *   0  converged (SHA-verified)
 *   1  a pass failed, or the state could not be read
 *   2  usage error
 *   4  timed out waiting for the round to become judgeable, OR the reviewer
 *      converged but another driver holds the Ready-mark lease — not full
 *      convergence, since that driver dying would leave the PR a draft
 *      forever with nothing left to retry it
 *   5  the PR stopped being open — the loop stops WITHOUT running another pass
 *   6  hit --max-rounds without converging
 *   7  the posting reviewer's check-run did not pass
 *   8  HITL-parked — everything left awaits a human decision; never wakes
 *      itself up. A re-arm unparks the items once EVERY one is answered by an
 *      owner, member or collaborator, and hands the answers to round one
 *   9  the PR conflicts with its base AND has nothing left to work — the base
 *      has to be merged in first. A conflict with live findings is a normal
 *      ROUND_READY instead; only the no-work case is terminal
 *  11  another LIVE driver already holds this PR's single-instance lock —
 *      refused without touching any state, naming the holder's doctor
 *      verdict and, when it is WEDGED, the --take-over command; also a
 *      --take-over refused for the holder's verdict or a dead holder's
 *      leftovers
 *  12  the review converged, but this worktree still has uncommitted state.
 *      The convergence itself is real (it is a claim about the remote); the
 *      leftovers are edits no round shipped — scratch probes, regenerated
 *      artefacts, a fix from a round that ended another way — and exiting 0
 *      over them is how they silently die with the worktree. Commit or
 *      discard them, then re-run
 *  13  another live WORKING TREE is driving this PR, met at
 *      the round's own bump-attempt. The single-instance lock above does
 *      not cover it: that lock is only ever held by another drive.ts, so
 *      an INTERACTIVE pass in another worktree — which takes no lock — is
 *      invisible to it. Nothing was written; stop rather than become the
 *      second resolver.
 *  14  the loop STALLED: $DRIVE_PR_STALL_ROUNDS (default 2) consecutive
 *      completed passes changed nothing this loop can observe — the
 *      reviewed head did not move and every thread/finding IDENTITY SET
 *      (not merely count — a substitution that swaps one resolved thread
 *      for one new one leaves the count unchanged) came back identical.
 *      A pass that exits 0 without acting (the measured case: a pass
 *      standing down after mistaking its own parent driver for a
 *      competing drive) burns the whole
 *      --max-rounds budget while the round headers look like progress;
 *      this stop names what did not happen instead. A DIFFERENT code from
 *      `13` deliberately: a caller reading the exit code alone must be able
 *      to tell "another working tree owns this PR" (recoverable by waiting
 *      or handing off) from "this pass is stuck and needs a human look"
 *      (recoverable by reading the pass output) — sharing one code
 *      collapsed that distinction, which the terminal-state table exists
 *      to preserve. The first time the streak reaches the threshold the
 *      driver runs ONE more round with the diagnostics in the pass's notice
 *      ($DRIVE_PR_PASS_NOTICE), and the stop prints what the passes recorded
 *      deciding in the handoff narrative.
 *  15  the pass hit $DRIVE_PR_PASS_TIMEOUT and was killed, more often than
 *      `drive.pass_deadline_retries` (default 2) lets the drive restart from:
 *      a witnessed kill is otherwise followed by the next round, the killed
 *      pass's leftovers reported and left in the tree for it. Distinct from
 *      `1` because it is the one pass failure that says nothing about the
 *      pass's own logic: it ran out of wall clock, and what a caller does
 *      next (widen the deadline, or go look for the hang) has no overlap
 *      with what a genuine pass failure asks for. It is also the only
 *      code here that can name an in-flight hang rather than a completed
 *      one — every other stop in this loop, `14` included, can only fire
 *      between rounds, which is where the hangs are not.
 *  16  QUOTA-PARKED: the pass died on a subscription usage wall that will
 *      not reopen within the sleep bound — a weekly window, an
 *      unclassifiable one, or a reset this loop could not resolve. NOT a
 *      pass failure and deliberately not `1`: nothing is wrong with the
 *      PR, the tree or the pass, and the recovery is a clock rather than
 *      a fix. A SHORT window does not reach this code at all — the driver
 *      sleeps through that one and resumes, since the whole cost of
 *      stopping there is a re-arm nobody is awake to perform. The park
 *      records the wall's account (hashed); a re-arm while the wall is in
 *      effect is admitted only from a pass billing another, known account.
 *  18  MAILBOX_STOPPED: a stop directive was observed at a round boundary.
 *      The in-flight pass, if any, already finished; normal exit releases locks.
 *  19  MAILBOX_PAUSE_TIMEOUT: a pause stayed active beyond the bounded wait.
 *      Resume the pause directive and re-arm the drive.
 *  20  TAKEN_OVER: another clone's takeover claim, newer than this driver's
 *      own, is on the pull request (found at a round boundary), or a rival's
 *      claim on the same ledger generation came first. That clone drives now.
 */
import { runMain } from "./lib/cli.ts";
import { span } from "../../../shared/trace.ts";
import { main } from "./lib/driver/main.ts";
import { driverRuntime } from "./lib/driver/runtime.ts";
export {
  roundFingerprint,
  resolveHandoffAt,
  advanceStallStreak,
  passExitDisposition,
  PASS_DEADLINE_EXIT,
  QUOTA_PARKED_EXIT,
  MAX_ROUNDS_EXIT,
  SINGLE_INSTANCE_LOCK_EXIT,
  WORKTREE_UNCLEAN_EXIT,
  STALLED_EXIT,
  MAILBOX_STOPPED_EXIT,
  MAILBOX_PAUSE_TIMEOUT_EXIT,
  TAKEN_OVER_EXIT,
  passTimeoutSeconds,
  finalCiWitnessPolls,
  ciRepairRounds,
  conflictRepairRounds,
  type RepairTask,
} from "./lib/driver/settings.ts";
export { inspect, claimWasTakenOver } from "./lib/driver/locks.ts";
export {
  driverStopExitCode,
  installStopControls,
  drainDriverRegistrations,
  finishDriverPassRegistrations,
  installDriverLifecycle,
  driverStopCompletionCleanup,
} from "./lib/driver/lifecycle.ts";

// Bun resolves the entry module's identity, including Windows path aliases.
// Importing helpers must never start the driver or acquire its locks.
if (import.meta.main) {
  runMain("drive.ts", async () => {
    try {
      return await span("drive", {}, main);
    } finally {
      // The shared coordinator owns exit while other cancellations are pending.
      if (driverRuntime.driverShuttingDown)
        await new Promise<never>(() => {
          // The shutdown coordinator owns process exit.
        });
    }
  });
}
