/** Route held and advisory failures before the drive spends an automatic CI repair. */
import { parkClasses } from "../../../../../shared/autonomy.ts";
import { layeredConfig } from "../../../../../shared/consumer.ts";
import { failedRunsField } from "./failed-runs.ts";
import { advisoryAction } from "./advisory-ci.ts";
import {
  classifyFailures,
  reviewedSpecialCiSettings,
} from "../ci-special-checks.ts";
import { sleep } from "../cli.ts";
import { FINAL_CI_POLL_SECONDS } from "./settings.ts";
import type { DriveRoundContext } from "./round-context.ts";
import type { FailingChecks } from "./infra-recovery.ts";

/** The ordinary verdict and repair inputs, or a completed special disposition. */
export async function specialCiDisposition(
  finalVerdict: string,
  staleRequiredFailure: boolean,
  context: DriveRoundContext,
  reviewedHead: string,
  failing: FailingChecks,
  repair: (
    verdict: string,
    context: DriveRoundContext,
    failing: FailingChecks,
  ) => Promise<number | "continue">,
): Promise<
  number | "continue" | { finalVerdict: string; failing: FailingChecks }
> {
  if (finalVerdict.startsWith("held:")) {
    console.error(
      `review converged; waiting for the CI hold to be released (${finalVerdict})`,
    );
    await sleep(FINAL_CI_POLL_SECONDS);
    return "continue";
  }
  if (!finalVerdict.startsWith("failing:") || staleRequiredFailure)
    return { finalVerdict, failing };
  if (failing.checkRunNames === null || failing.statusNames === null)
    return { finalVerdict, failing };
  return await advisoryDisposition(
    finalVerdict,
    context,
    reviewedHead,
    failing,
    [...failing.checkRunNames, ...failing.statusNames],
    repair,
  );
}

type Repair = (
  verdict: string,
  context: DriveRoundContext,
  failing: FailingChecks,
) => Promise<number | "continue">;
type Disposition =
  | number
  | "continue"
  | { finalVerdict: string; failing: FailingChecks };
/** Apply the person's disposition or keep only the failures the repair can act on. */
async function advisoryDisposition(
  finalVerdict: string,
  context: DriveRoundContext,
  reviewedHead: string,
  failing: FailingChecks,
  names: string[],
  repair: Repair,
): Promise<Disposition> {
  const enabled = parkClasses(layeredConfig()).includes("reviewer-posture");
  const advisory = enabled ? reviewedSpecialCiSettings().advisoryChecks : [];
  if (
    context.dryRun &&
    names.length > 0 &&
    names.every((n) => advisory.includes(n))
  ) {
    console.error("(dry-run) would park the advisory CI findings for a person");
    return 1;
  }
  const action = await advisoryAction(context.pr, reviewedHead, names);
  if (action === "parked") return 8;
  if (action === "failed" || action === "manual") return 1;
  if (action === "waive") {
    console.error(
      "The person waived the advisory findings on this head; branch protection and required-check freshness still apply.",
    );
    return 1;
  } else if (action === "fix") {
    return await repair(finalVerdict, context, failing);
  }
  return mixedFailureInputs(finalVerdict, failing, names, advisory);
}

/** Keep check names, status URLs and workflow provenance in the same repair subset. */
function mixedFailureInputs(
  finalVerdict: string,
  failing: FailingChecks,
  names: string[],
  advisory: string[],
): { finalVerdict: string; failing: FailingChecks } {
  const repairNames = classifyFailures(names, [], advisory, false).repair;
  if (repairNames.length > 0 && repairNames.length < names.length) {
    finalVerdict = `failing: ${repairNames.join(", ")}`;
    failing = {
      ...failing,
      checkRunNames: (failing.checkRunNames ?? []).filter(
        (n) => !advisory.includes(n),
      ),
      statusNames: (failing.statusNames ?? []).filter(
        (n) => !advisory.includes(n),
      ),
      runs: repairRuns(failing.runs, advisory),
      statuses: Array.isArray(failing.statuses)
        ? failing.statuses.filter((s) => !advisory.includes(s.context))
        : failing.statuses,
    };
  }
  return { finalVerdict, failing };
}

/** Drop advisory-only workflows and retain shared workflows with only repair job names. */
function repairRuns(raw: unknown, advisory: readonly string[]): unknown {
  if (!Array.isArray(raw)) return raw;
  return failedRunsField(raw).flatMap((run) => {
    const jobNames = run.jobNames?.filter((n) => !advisory.includes(n));
    if (jobNames === undefined) return [run];
    if (jobNames.length === 0) return [];
    return [{ ...run, jobNames }];
  });
}
