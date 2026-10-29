/** Distinguish pass deadlines, quota walls and ordinary failures while preserving mailbox precedence. */
import type { RunHandle } from "../proc.ts";

import type { DriveRoundContext } from "./round-context.ts";

import { PASS_DEADLINE_EXIT } from "./settings.ts";

import type { run } from "./../proc.ts";

import type { PreparedSpawn, QuotaSnapshot } from "../quota/index.ts";

import { detectQuotaBlock } from "./../quota/index.ts";

import { handleQuotaBlock } from "./review-quota.ts";

import { unpushedCountAdvice } from "./../driven-branch.ts";

import { git, gitCallTimeoutSeconds } from "./../proc.ts";

import {
  admitDeadlineRestart,
  deadlineNotice,
  describeLeftovers,
  inheritedHeadOf,
  passLeftovers,
} from "./restart.ts";

async function handlePassDeadline(
  passDeadlineSec: number,
  round: number,
  passHandle: RunHandle | null,
  context: DriveRoundContext,
): Promise<number | "continue"> {
  console.error(
    `pass hit its ${passDeadlineSec}s deadline on round ${round} and was killed.`,
  );
  // `run()` resolves once its own SIGKILL escalation FIRES — proof a
  // signal was sent, not that the process group is actually gone (a
  // descendant in uninterruptible sleep, or one that escaped the group,
  // can outlive it). Re-poll the same witnessed-termination check the
  // takeover and signal paths already use before this driver's own
  // 'exit' handler releases its locks: a live pass under a released
  // lock is the exact two-drivers-one-tree state those locks exist to
  // prevent. Idempotent — if `run()`'s own escalation already finished
  // the job, this resolves immediately.
  const witnessed = passHandle === null || (await passHandle.stop());
  if (!witnessed) {
    console.error(
      "  Its termination could NOT be witnessed — some descendant may still be running.",
    );
    console.error(
      "  NOT releasing this drive's locks: a live pass under a released lock is the",
    );
    console.error(
      "  exact two-drivers-one-tree state they exist to prevent. Confirm the tree is",
    );
    console.error(
      "  actually gone, then remove the lock dir to re-arm (see `acquire`'s message).",
    );
    context.held.length = 0;
  }
  console.error(
    "  ($DRIVE_PR_PASS_TIMEOUT / --pass-timeout; 0 disables this deadline.)",
  );
  // An unwitnessed termination keeps the locks and stops here: neither a
  // mailbox wait (which can itself wait out a live pause) nor a restart is
  // safe beside a descendant that may still be writing the tree.
  if (!witnessed) return PASS_DEADLINE_EXIT;
  // A directive sent WHILE this pass ran is honored before anything else.
  const mailboxAfterDeadline = await context.mailboxCheckpoint();
  if (typeof mailboxAfterDeadline === "number") return mailboxAfterDeadline;
  return await restartAfterDeadline(passDeadlineSec, round, context);
}

/**
 * The two checks the stop used to ask a person for, run here: what the
 * killed pass left uncommitted and unpushed. Both stay in the tree. Within
 * `drive.pass_deadline_retries` the next round starts and its pass is told
 * what it inherits; past it the drive stops as `PASS_DEADLINE`.
 */
async function restartAfterDeadline(
  passDeadlineSec: number,
  round: number,
  context: DriveRoundContext,
): Promise<number | "continue"> {
  const leftovers = await passLeftovers();
  console.error(
    "  The pass tree is gone; what it was doing when the clock ran out is NOT rolled back.",
  );
  for (const line of describeLeftovers(leftovers)) console.error(`  ${line}`);
  // Counted in the drive state, so the budget spans every process that
  // drives this PR: a re-arm or a takeover does not get a fresh one.
  const restart = await admitDeadlineRestart(
    context.pr,
    context.deadlineRetryBudget,
  );
  if (restart === null) {
    console.error(
      "  Could not record this restart in the drive state, so the retry budget cannot be enforced: stopping.",
    );
  } else if (restart.admitted) {
    console.error(
      `  Restarting: deadline retry ${restart.taken} of ${context.deadlineRetryBudget} for this drive (drive.pass_deadline_retries). The leftovers stay in the tree for the next pass.`,
    );
    context.passNotice = deadlineNotice(round, passDeadlineSec, leftovers);
    // Committed but unpushed work puts local HEAD ahead of the PR head, which
    // the next gate would read as head lag and never hand out the round that
    // pushes it. That gate accepts exactly this witnessed head instead.
    context.inheritedHead = inheritedHeadOf(leftovers);
    // A killed pass is not a completed one: it must not count toward the
    // stall streak, which compares the gates around COMPLETED passes.
    context.prevFingerprint = null;
    context.noopRounds = 0;
    return "continue";
  }
  if (restart !== null)
    console.error(
      `  The pass-deadline retry budget is spent (${context.deadlineRetryBudget}, drive.pass_deadline_retries; ${restart.taken} restart(s) already taken by this drive): stopping.`,
    );
  console.error(
    `  Before re-arming, settle what the pass left: \`git status --short\` and ${await unpushedCountAdvice(
      git,
      process.cwd(),
      { timeoutSec: gitCallTimeoutSeconds() },
    )}.`,
  );
  return PASS_DEADLINE_EXIT;
}

export async function handleFailedReviewPass(
  passRes: Awaited<ReturnType<typeof run>>,
  passDeadlineSec: number,
  round: number,
  passHandle: RunHandle | null,
  context: DriveRoundContext,
  passStartedAt: Date,
  preexistingSessions: ReadonlySet<string>,
  prepared: PreparedSpawn | null,
  preexistingSnapshot: QuotaSnapshot,
  disposition: { kind: "ok" | "not-open" | "failed"; exit: number },
): Promise<number | "continue"> {
  // `timedOut` rather than `code === 124`, because the pass is an arbitrary
  // command whose exit space is its own: one that exits 124 for its own
  // reasons must not be reported as a deadline this driver never fired.
  if (passRes.timedOut) {
    return await handlePassDeadline(
      passDeadlineSec,
      round,
      passHandle,
      context,
    );
  }

  // A usage wall is not a pass failure, and reporting it as one is what
  // sends an operator to read a pass that did nothing wrong. Ask the
  // adapters before saying anything about the exit code. One `now` grounds
  // both the adapters' future-timestamp rejection and the sleep/stop
  // decision below, rather than each reading the clock separately a few
  // lines apart for what is, in substance, one detect-then-decide step.
  const now = new Date();
  const block = detectQuotaBlock(
    {
      cwd: process.cwd(),
      since: passStartedAt,
      now,
      preexistingSessions,
      ...(prepared !== null ? { correlation: prepared.correlation } : {}),
    },
    preexistingSnapshot.truncatedByVendor,
  );
  if (block !== null) {
    return await handleQuotaBlock(block, now, round, context);
  }

  // A directive sent WHILE this pass ran must still be honored before
  // reporting this generic non-quota failure. `clear`/`resumed` fall
  // through to reporting the failure — it already happened — while
  // `stopped`/`pause-timeout`/`unreadable` return their own exit code in
  // its place.
  const mailboxBeforeFailureReport = await context.mailboxCheckpoint();
  if (typeof mailboxBeforeFailureReport === "number")
    return mailboxBeforeFailureReport;
  console.error(
    `pass failed on round ${round} (exit ${passRes.code}); not driving further`,
  );
  return disposition.exit;
}
