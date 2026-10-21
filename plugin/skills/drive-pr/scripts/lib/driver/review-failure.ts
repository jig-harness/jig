/** Distinguish pass deadlines, quota walls and ordinary failures while preserving mailbox precedence. */
import type { RunHandle } from "../proc.ts";

import type { DriveRoundContext } from "./round-context.ts";

import { PASS_DEADLINE_EXIT } from "./settings.ts";

import type { run } from "./../proc.ts";

import type { PreparedSpawn, QuotaSnapshot } from "../quota/index.ts";

import { detectQuotaBlock } from "./../quota/index.ts";

import { handleQuotaBlock } from "./review-quota.ts";

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
  if (witnessed) {
    console.error(
      "  The pass tree is gone, but whatever it was doing when the clock ran out is NOT",
    );
    console.error(
      "  rolled back. Check `git status --short` for an uncommitted fix and",
    );
    console.error(
      "  `git rev-list --count @{u}..HEAD` for a committed-but-unpushed one before re-arming;",
    );
    console.error(
      "  a killed pass strands work at whatever step it had reached.",
    );
  } else {
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
  // A directive sent WHILE this pass ran must still be honored before
  // reporting PASS_DEADLINE — but only when the tree's termination was
  // WITNESSED: checking mailbox (which can itself wait out a live
  // pause) is not safe to do immediately after deciding a descendant
  // may still be alive and out there unsupervised. The unwitnessed
  // branch above already leaves `held` cleared and returns
  // unconditionally, same as before.
  if (witnessed) {
    const mailboxAfterDeadline = await context.mailboxCheckpoint();
    if (typeof mailboxAfterDeadline === "number") return mailboxAfterDeadline;
  }
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
