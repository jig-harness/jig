/** Timed-out jobs in the final CI evaluation: how they join the failing set and how a repair pass is told of them. */

import { timedOutOnHead } from "../cancelled-recovery-live.ts";
import { type TimedOutJob, timeoutWording } from "../job-timeout.ts";
import { withTimedOut } from "./ci-recovery.ts";
import type { FailingChecks } from "./infra-recovery.ts";
import type { DriveRoundContext } from "./round-context.ts";

/**
 * The repair pass's detail: the failing check names, then each timed-out job
 * among them with its limit and run time, so the pass looks for why it ran
 * past its limit.
 */
export function repairDetail(
  names: readonly string[],
  timedOut: readonly TimedOutJob[],
): string {
  const told = timedOut.filter((job) => names.includes(job.name));
  const listed = names.join(", ");
  return told.length === 0
    ? listed
    : `${listed}; timed out: ${told.map(timeoutWording).join("; ")}`;
}

/**
 * The jobs the runner stopped at their time limit are failures the status
 * report does not list: they join the set before any policy judges it.
 */
export async function joinTimedOut(
  context: DriveRoundContext,
  reviewedHead: string,
  finalVerdict: string,
  staleRequiredFailure: boolean,
  failing: FailingChecks,
): Promise<{
  timedOut: TimedOutJob[];
  finalVerdict: string;
  failing: FailingChecks;
  staleRequiredFailure: boolean;
}> {
  // Classified on its own: the freshness doubt covers the failures the report
  // names, never a job read from the runner on this head.
  const timedOut =
    finalVerdict.startsWith("failing:") && !context.dryRun
      ? await timedOutOnHead(reviewedHead)
      : [];
  if (timedOut.length === 0)
    return { timedOut, finalVerdict, failing, staleRequiredFailure };
  // Every reported failure stays in the set, so the policy still sees the
  // advisory ones and their workflows beside the timed-out job.
  const joined = withTimedOut(failing, { timedOut, recovery: "none" });
  return {
    timedOut,
    staleRequiredFailure: false,
    failing: joined,
    finalVerdict: `failing: ${[...(joined.checkRunNames ?? []), ...(joined.statusNames ?? [])].join(", ")}`,
  };
}
