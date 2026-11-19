/** Recover failed CI and wait for accepted retries before repairing or certifying a head. */
import type { DriveRoundContext } from "./round-context.ts";
import {
  recoverInfrastructureFailure,
  type FailingChecks,
} from "./infra-recovery.ts";
import { attemptsFor, retryFailedChecks } from "./ci-attempts.ts";
import { retryWitness } from "./ci-retry-wait.ts";
import { reviewedRerunFailedOnceSetting } from "./ci-attempts-config.ts";
import { failedCheckForge } from "./ci-retry-forge.ts";
import { recordCiAttempt } from "./ci-attempt-record.ts";
import { exportPolicyBase } from "./policy-base.ts";
import { failedRunsField } from "./failed-runs.ts";
import {
  recoverCancelledOnHead,
  timedOutOnHead,
} from "../cancelled-recovery-live.ts";
import {
  isTimedOut,
  recoveryExit,
  type TimedOutRecovery,
} from "../cancelled-recovery-reads.ts";
import type { TimedOutJob } from "../job-timeout.ts";
import { sleep } from "../cli.ts";
import { FINAL_CI_POLL_SECONDS, UNLABEL_SETTLE_SECONDS } from "./settings.ts";

export async function pendingRetryDisposition(
  context: DriveRoundContext,
  head: string,
): Promise<number | "continue" | null> {
  const witness = await retryWitness(
    head,
    attemptsFor(context),
    failedCheckForge,
    context.witnessWaitLimit,
  );
  if (witness === "expired") return 1;
  if (witness === "refresh") return "continue";
  if (witness === "waiting") {
    await sleep(FINAL_CI_POLL_SECONDS);
    return "continue";
  }
  return null;
}

/**
 * Whether every failing check is a job of a workflow run that concluded
 * `cancelled`, with no failing commit status beside them: an always-run
 * aggregator fails when a job it needs was cancelled, though its run stopped
 * rather than failed.
 */
export function onlyInCancelledRuns(failing: FailingChecks): boolean {
  const names = failing.checkRunNames;
  if (names === null || names.length === 0) return false;
  if (failing.statusNames === null || failing.statusNames.length > 0)
    return false;
  const runs = failedRunsField(failing.runs);
  return (
    runs.length > 0 &&
    runs.every((run) => run.conclusion === "cancelled") &&
    names.every((name) => runs.some((run) => run.jobNames?.includes(name)))
  );
}

/** Repair `failing`, whose timed-out jobs are named to the pass with their limit and run time. */
export type RepairTimedOut = (
  failing: FailingChecks,
  timedOut: readonly TimedOutJob[],
) => Promise<number | "continue">;

/**
 * The failing checks with the timed-out jobs added, each a failing check run
 * with the workflow run behind it, so the CI-repair path selects, charges and
 * tells them as it does a failed check.
 */
export function withTimedOut(
  failing: FailingChecks | null,
  recovery: TimedOutRecovery,
): FailingChecks {
  const names = recovery.timedOut.map((job) => job.name);
  const runs = failedRunsField(failing?.runs);
  for (const job of recovery.timedOut) {
    if (job.run === null) continue;
    const listed = runs.find((run) => run.id === job.run?.id);
    if (listed === undefined) runs.push({ ...job.run });
    else
      runs.splice(runs.indexOf(listed), 1, {
        ...listed,
        jobNames: [...new Set([...(listed.jobNames ?? []), job.name])],
      });
  }
  return {
    checkRunNames: [...new Set([...(failing?.checkRunNames ?? []), ...names])],
    statusNames: failing?.statusNames ?? [],
    runs: runs.sort((a, b) => a.id - b.id),
    ...(failing?.statuses === undefined ? {} : { statuses: failing.statuses }),
  };
}

/**
 * A failure only cancelled runs carry goes through the cancelled-run recovery
 * (its grace period and one re-run per head) before any retry or repair. A
 * real failure comes back from that re-run in a run that is not cancelled,
 * and is repaired then; `null` when the recovery has nothing to re-run. A job
 * the runner stopped at its time limit is repaired at once, beside the
 * failure, through `repair`: a re-run would stop at the same limit.
 */
export async function cancelledRunRecovery(
  finalVerdict: string,
  stale: boolean,
  context: DriveRoundContext,
  head: string,
  failing: FailingChecks,
  repair: RepairTimedOut,
): Promise<number | "continue" | null> {
  if (!finalVerdict.startsWith("failing:") || stale) return null;
  if (!onlyInCancelledRuns(failing)) {
    // A job the runner stopped at its time limit beside a failure in a run
    // that was not cancelled is named to the same repair.
    if (context.dryRun) return null;
    const timedOut = await timedOutOnHead(head);
    return timedOut.length === 0
      ? null
      : await repair(
          withTimedOut(failing, { timedOut, recovery: "none" }),
          timedOut,
        );
  }
  if (context.dryRun) {
    console.error(
      `(dry-run) would recover '${finalVerdict}' as a cancellation: it failed only in cancelled runs, so no CI-repair pass`,
    );
    return 1;
  }
  const recovery = await recoverCancelledOnHead(context.pr, head);
  if (recovery === "unknown")
    console.error(
      `review converged; '${finalVerdict}' failed only in cancelled runs, and their recovery could not establish the head's state; stopping`,
    );
  const stop = recoveryExit(recovery);
  if (stop !== null) return stop;
  if (isTimedOut(recovery))
    return await repair(withTimedOut(failing, recovery), recovery.timedOut);
  if (recovery === "none") return null;
  console.error(
    `review converged; '${finalVerdict}' failed only in cancelled runs, so it is recovered as a cancellation, not repaired`,
  );
  await sleep(FINAL_CI_POLL_SECONDS);
  return "continue";
}

export async function beforeRepairRecovery(
  finalVerdict: string,
  stale: boolean,
  context: DriveRoundContext,
  head: string,
  failing: FailingChecks,
): Promise<number | "continue" | null> {
  if (!finalVerdict.startsWith("failing:") || stale) return null;
  const infra = await recoverInfrastructureFailure(context, head, failing);
  if (infra !== null) return infra;
  if (context.dryRun || context.agent.length === 0) return null;
  // A base that moved or a retargeted PR must not leave the previous base's permission in force.
  const policyBase = await exportPolicyBase(context.pr);
  if ("error" in policyBase) {
    // No retry authority without a readable base; the repair path is unaffected.
    console.error(`CI retry skipped, policy unreadable: ${policyBase.error}`);
    return null;
  }
  const enabled = reviewedRerunFailedOnceSetting();
  if (!enabled.ok) {
    console.error(enabled.failure.reason);
    return 1;
  }
  if (!enabled.value) return null;
  const checkpoint = await context.mailboxCheckpoint();
  if (typeof checkpoint === "number") return checkpoint;
  if (checkpoint === "resumed") return "continue";
  const retried = await retryFailedChecks(
    context.pr,
    head,
    failing,
    attemptsFor(context),
    failedCheckForge,
    (detail) => recordCiAttempt(context.pr, "rerun", detail),
  );
  if (retried === "indeterminate") {
    console.error(
      "The failed-check retry was not acknowledged; CI remains indeterminate rather than starting a repair.",
    );
    return 1;
  }
  if (!retried) return null;
  await sleep(UNLABEL_SETTLE_SECONDS);
  return "continue";
}
