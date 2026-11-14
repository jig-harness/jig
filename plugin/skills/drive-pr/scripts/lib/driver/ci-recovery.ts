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
  const enabled = reviewedRerunFailedOnceSetting();
  if (!enabled.ok) {
    console.error(enabled.failure.reason);
    return 1;
  }
  if (!enabled.value || context.dryRun || context.agent.length === 0)
    return null;
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
