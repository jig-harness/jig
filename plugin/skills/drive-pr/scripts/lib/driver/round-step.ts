/** Order one round boundary, status gate, pass and Ready transition without bypassing admission checks. */
import type { DriveRoundContext } from "./round-context.ts";

import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";

import { driveState, driveTs } from "./paths.ts";

import { armCommand, passBotsOnly } from "./rearm.ts";

import { runConvergencePhase } from "./convergence.ts";

import { loopEconomy } from "./reports.ts";

import { runConflictPhase } from "./conflict.ts";

import { driverRuntime } from "./runtime.ts";

import {
  SINGLE_INSTANCE_LOCK_EXIT,
  FINAL_CI_POLL_SECONDS,
} from "./settings.ts";

import { sleep } from "./../cli.ts";

import { type MarkReady, markReadyDueAfterRound } from "./../pr-policy.ts";

import { readRoundStatus } from "./round-status.ts";

import {
  checkRoundStall,
  readRoundBudget,
  prepareRoundPass,
} from "./round-budget.ts";

import { preparePassBoundary, markReadyAfterRound } from "./round-ready.ts";

import { runReviewPassPhase } from "./review-pass.ts";

import { standDownOnNewerClaim } from "./ledger.ts";

async function gateRoundStatus(
  context: DriveRoundContext,
  code: number,
  status: Record<string, unknown>,
  reasonLine: string,
): Promise<number | "continue" | null> {
  // Keep the resumable trail current even if the pass below dies mid-round:
  // the handoff file, and under a driver the pull request's drive ledger.
  await run(tsArgv(driveState, ["handoff", context.pr]), {
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });

  switch (code) {
    case 3: {
      const phase = await runConvergencePhase(context, status);
      if (phase === "continue") return "continue";
      return phase;
    }
    case 8: {
      // Deliberately terminal. Re-arming here is a measured failure: the loop
      // wakes, re-reads the same undeferrable threads, learns nothing it may
      // act on, and burns turns until something external stops it.
      console.error(
        "HITL-parked — the decisions below need a human; not re-arming.",
      );
      const get = await run(tsArgv(driveState, ["get", context.pr]), {
        stderr: "ignore",
      });
      try {
        const state = JSON.parse(get.stdout) as {
          parked?: Array<{ kind: string; key: string; reason: string }>;
        };
        for (const p of state.parked ?? []) {
          console.error(`  [${p.kind}] ${p.key}\n    ${p.reason}`);
        }
      } catch {
        // best-effort listing, like the bash `|| true`
      }
      // What picks it up again: answers, not a wake-up (`rearm.ts`).
      console.error(
        "  Answer each one on its thread, or in a pull-request comment with a line `answer <key>: …`, as an",
      );
      console.error(
        "  owner, member or collaborator. Once every one is answered, re-arm: the re-arm unparks",
      );
      console.error("  them and hands the answers to the first round:");
      console.error(
        `    ${armCommand(driveTs, context.pr, passBotsOnly(context.agent), "", context.agent)}`,
      );
      // A park is a finished drive too, and the one whose cost a human is
      // about to weigh by hand — so it gets the same economy block the
      // converged and exhausted exits do.
      process.stderr.write(await loopEconomy(context.pr));
      return 8;
    }
    case 9: {
      const phase = await runConflictPhase(context, status, reasonLine);
      if (phase === "continue") return "continue";
      return phase;
    }
    // There is no `case 10`. It was `PR_IS_DRAFT`, terminal and un-re-armed
    // on the premise that no reviewer arm looks at a draft; the in-house AI
    // reviewer reviews drafts (measured — see mark-ready.ts), so a drive on
    // one now proceeds and marks it Ready itself at the round
    // `pull_requests.mark_ready` declares.
    // The CODE stays retired rather than being recycled for something else:
    // an operator reading `10` out of an old log or a wrapper script should
    // find nothing rather than a different meaning.
    case 0:
      break;
    default:
      // 1 / 4 / 5 / 7 / 13 all propagate verbatim. Note that 5 (PR merged
      // or closed) lands HERE, before the pass runs — the loop never hands
      // work to an agent that would push it onto an orphaned branch. 13
      // (another working tree is driving this PR) lands here for
      // the same reason and wants the same treatment: stop before the pass,
      // rather than become the second resolver.
      //
      // This check alone is NOT the merged-mid-loop guarantee, though: the
      // pass that runs below validates, commits and pushes, and the PR can
      // merge at any point during it. A liveness check taken before a
      // multi-minute pass says nothing about the moment of the push. That
      // is why the push itself must go through `guarded-push.ts`, which
      // re-checks immediately before pushing — see SKILL.md § 6. This check
      // keeps the loop from *starting* work it cannot land; guarded-push.ts
      // keeps it from *finishing* one.
      return code;
  }

  return null;
}

async function waitForRoundBoundary(
  context: DriveRoundContext,
): Promise<number | "continue" | null> {
  // The heartbeat timer reports a takeover here rather than acting on it
  // itself: a lock recovered out from under this drive means another driver
  // is already working the same worktree or PR, and continuing is exactly
  // the concurrency the lock exists to prevent. Nothing is released on the
  // way out — `release` refuses a lock whose nonce is no longer ours.
  if (driverRuntime.compromised !== "") {
    console.error(
      `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver mid-drive — stopping rather than running a second loop.`,
    );
    return SINGLE_INSTANCE_LOCK_EXIT;
  }
  // Another clone's takeover claim, newer than this driver's own, ends the
  // drive here, before another pass could reply beside its successor.
  const takenOver = await standDownOnNewerClaim(context.pr);
  if (takenOver !== null) return takenOver;
  const mailboxAtRoundStart = await context.mailboxCheckpoint();
  if (typeof mailboxAtRoundStart === "number") return mailboxAtRoundStart;
  if (mailboxAtRoundStart === "resumed") context.finalCiWait.clear();
  // Reuse only a keep-waiting decision. Terminal claims still pass through
  // live status, release, final-ready and final status below.
  const skippedFinalCi = await context.finalCiWait.skip(
    context.witnessWaits,
    context.witnessWaitLimit,
  );
  if (skippedFinalCi !== null) {
    if (skippedFinalCi === "witness") context.witnessWaits += 1;
    await sleep(FINAL_CI_POLL_SECONDS);
    return "continue";
  }

  return null;
}

export async function runRoundIteration(
  context: DriveRoundContext,
  forward: string[],
  probeFlags: string[],
  stallRounds: number,
  markReadyPolicy: MarkReady,
): Promise<number | "continue" | null> {
  {
    const stage = await waitForRoundBoundary(context);
    if (stage !== null) return stage;
  }
  const readRoundStatusResult = await readRoundStatus(
    context,
    forward,
    probeFlags,
  );
  if (typeof readRoundStatusResult !== "object") return readRoundStatusResult;
  const { code, status, reasonLine } = readRoundStatusResult;
  {
    const stage = await gateRoundStatus(context, code, status, reasonLine);
    if (stage !== null) return stage;
  }
  {
    const stage = await checkRoundStall(status, context, stallRounds);
    if (stage !== null) return stage;
  }
  {
    const stage = await preparePassBoundary(status, context);
    if (stage !== null) return stage;
  }
  // drive-status.ts bumped the durable round count for this head on its way
  // to exit 0, so read it back rather than deriving it; the durable
  // per-head attempt count is bumped here, because a pass is this loop's
  // event, not the status check's. Both reads are hard — a state file this
  // loop cannot read is a loop with no bound, and continuing on a default
  // is the fail-open.
  const readRoundBudgetResult = await readRoundBudget(
    status,
    context,
    reasonLine,
  );
  if (typeof readRoundBudgetResult !== "object") return readRoundBudgetResult;
  const {
    counted,
    peekedAttempts,
    peekedLastReflectedRound,
    peekedLastReflectedAttempts,
    round,
    apiHead,
  } = readRoundBudgetResult;
  {
    const stage = await prepareRoundPass(
      counted,
      peekedAttempts,
      peekedLastReflectedRound,
      peekedLastReflectedAttempts,
      round,
      context,
    );
    if (stage !== null) return stage;
  }
  // The boundary's claim check can be minutes old by the spawn (a mailbox
  // pause, a status wait): every pass, review or repair, is spawned behind a
  // `beforePass` checkpoint that reads the claims again.
  //
  // A pass that discovers the PR merged mid-round exits 5 —
  // `guarded-push.ts` refuses on a merged or closed PR and the pass
  // propagates it. That is the documented terminal `PR_NOT_OPEN`, not a
  // broken pass, and flattening it to 1 tells the caller "your pass is
  // failing, look at it" about a PR that is simply finished. Preserve
  // exactly that one code.
  //
  // Only that one. The pass is an arbitrary command whose exit space is its
  // own, and blanket propagation would collide with this script's: an agent
  // exiting 3 for its own reasons would report SHA-verified convergence.
  // Every other non-zero stays 1, which is what it is — a pass that failed.
  // `detached` so a stop reaches the whole pass tree — the agent, its tool
  // subprocesses, and the `guarded-push.ts`/`git push` underneath them —
  // rather than the agent process alone. It costs tty signal delivery, which
  // the handlers installed above now supply instead, and the controlling
  // terminal, so a descendant that wants to PROMPT (a git credential helper)
  // now fails instead of asking. That is the right answer for a driver whose
  // whole premise is running unattended: an unanswerable prompt is a hang no
  // deadline in this skill covers.
  //
  // Captured BEFORE the spawn and used as the quota scan's `since` floor.
  // The account-wide transcripts hold every wall this machine ever hit, so
  // without a floor the newest one is indistinguishable from this pass's own
  // — and a drive re-armed after an earlier block would read that stale wall
  // and park itself again, forever.
  {
    const phase = await runReviewPassPhase(context, apiHead, round);
    if (phase !== "passed") return phase;
  }
  // A round completed: triaged, replied, resolved, and pushed whatever it
  // fixed. THIS is the moment the draft→Ready transition is owed — not the
  // start of the drive, and not convergence.
  //
  // Not at the start, because the whole value of waiting is that CodeRabbit
  // refuses to look at a draft and reviews a Ready PR exactly once per push:
  // marking it Ready before the first round spends that pass on the untouched
  // first draft of the branch, which is the spend this ordering exists to
  // avoid. Not at convergence either — by then the drive is over, and the
  // external findings it summons would land on a PR nobody is driving.
  //
  // Gated on a COMPLETED pass rather than on a push landing. A round that
  // adjudicated every finding as rejected/wont-fix pushes nothing and is
  // still a cleaned-up feedback set, which is what the external reviewer is
  // being handed; keying on the head moving would leave that round's PR a
  // draft forever.
  //
  // `mark-ready.ts` is idempotent and durably once-only, so calling it after
  // EVERY round is correct and costs one state read on all but the first.
  //
  // ITS EXIT CODE IS HANDLED, not ignored, and the non-zero codes get
  // opposite treatment because they mean opposite things:
  //
  //   5 — the PR stopped being open. Deliberately NOT propagated here: the
  //     gate at the top of the next iteration owns that decision and re-reads
  //     liveness anyway, so it costs one cheap loop to let the one place that
  //     is allowed to declare PR_NOT_OPEN declare it.
  //   anything else — the transition was owed and could not be made. One
  //     failure is survivable (the lease is released, so the next round
  //     retries) and the round itself succeeded, so aborting a productive
  //     drive over it would be the wrong trade. A failure that REPEATS is a
  //     different animal: it does not get better by itself, and continuing
  //     silently would run out the round budget on a PR that stays a draft —
  //     which is exactly the "may run more rounds and eventually terminate at
  //     --max-rounds while the PR remains draft" this once did. So the second
  //     consecutive one stops the drive and says which command to run by
  //     hand.
  if (!context.keepDraft && markReadyDueAfterRound(markReadyPolicy, round)) {
    {
      const stage = await markReadyAfterRound(context, round);
      if (stage !== null) return stage;
    }
  }

  return null;
}
