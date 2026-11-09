/** Which workflow runs a CI-repair pass is told it may re-run. */
import {
  ciHoldTransitions,
  createdUnderHold,
  type LabelTransition,
} from "../ci-hold.ts";
import { holdLabelPolicy } from "../ci-policy.ts";
import { timelineEvents } from "../pr-timeline.ts";
import type { FailedRun } from "../status/workflow-runs.ts";

/** `failingRuns` off a `drive-status.ts --json` report, shape-checked. */
export function failedRunsField(raw: unknown): FailedRun[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (run): run is FailedRun =>
      typeof run === "object" &&
      run !== null &&
      typeof (run as FailedRun).id === "number" &&
      typeof (run as FailedRun).createdAt === "string",
  );
}

/**
 * The ids of the failed runs a pass may re-run: never one created while the CI
 * hold's label was on, because a re-run replays that event, label and all.
 * `null` transitions mean the hold could not be read, and then the list is
 * empty: a pass told no run re-runs none, and one that re-ran a held run would
 * only meet the hold again.
 */
export function runsOutsideHold(
  failed: readonly FailedRun[],
  transitions: readonly LabelTransition[] | null,
): number[] {
  if (transitions === null) return [];
  return failed
    .filter((run) => !createdUnderHold(run.createdAt, transitions))
    .map((run) => run.id);
}

/** What a repair pass is told, from the report's `failingRuns`, and says so. */
export async function failedRunsToTell(
  pr: string,
  failingRuns: unknown,
): Promise<number[]> {
  const runs = await rerunnableRuns(pr, failedRunsField(failingRuns));
  if (runs.length > 0)
    console.error(`  Failed run(s) behind it: ${runs.join(", ")}.`);
  return runs;
}

/** `runsOutsideHold` over the pull request's own label history. */
export async function rerunnableRuns(
  pr: string,
  failed: readonly FailedRun[],
): Promise<number[]> {
  if (failed.length === 0) return [];
  let label: string | null;
  try {
    label = holdLabelPolicy();
  } catch {
    return runsOutsideHold(failed, null);
  }
  if (label === null) return runsOutsideHold(failed, []);
  const events = await timelineEvents(pr);
  return runsOutsideHold(
    failed,
    events === null ? null : ciHoldTransitions(events, label),
  );
}
