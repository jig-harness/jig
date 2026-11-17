/**
 * The cancelled runs a label write caused. A label event on a pull request
 * starts the workflows that listen for it; under a concurrency group with
 * `cancel-in-progress`, those runs cancel the run in flight on the head and
 * each other within seconds. A drive writes its own state labels whenever it
 * is armed, parked or re-armed, so without this reading every re-arm would
 * create the cancellation it then recovers from, and spend the head's
 * once-per-head re-run on it.
 *
 * The workflow runs API does not say which action of a `pull_request` event
 * started a run, so a run counts as label-started when it was created within
 * {@link LABEL_RUN_WINDOW_MS} after a label event on the pull request's
 * timeline. A push's run created in that window reads the same way; that costs
 * at most one re-run of it outside the budget, since its next attempt is no
 * longer a first one.
 */
import { parseMs } from "../../../../shared/time.ts";
import type { WorkflowRun } from "./status/workflow-runs.ts";

/** How long after a label event the forge creates the runs it starts. */
export const LABEL_RUN_WINDOW_MS = 30_000;

/**
 * How long recovery waits after the latest label write: past the window and
 * the second the forge's times are rounded to, so a re-run it then requests
 * starts after every run that write could have started.
 */
export const LABEL_SETTLE_MS = LABEL_RUN_WINDOW_MS + 1_000;

/**
 * When each label was added or removed on the timeline, in milliseconds,
 * leaving out the CI hold's label: its runs are the hold's to settle. Events
 * that are not label transitions, or that carry no readable time or name, are
 * skipped, which reads them as no label write at all.
 */
export function labelWriteTimes(
  events: readonly unknown[],
  holdLabel: string | null,
): number[] {
  const times: number[] = [];
  for (const value of events) {
    if (typeof value !== "object" || value === null) continue;
    const event = value as Record<string, unknown>;
    if (event.event !== "labeled" && event.event !== "unlabeled") continue;
    const label = event.label as Record<string, unknown> | null | undefined;
    if (typeof label?.name !== "string" || label.name === holdLabel) continue;
    if (typeof event.created_at !== "string") continue;
    const at = parseMs(event.created_at);
    if (Number.isFinite(at)) times.push(at);
  }
  return times;
}

/** Whether `time` falls within the window after some label write. */
function afterWrite(time: number, writes: readonly number[]): boolean {
  return (
    Number.isFinite(time) &&
    writes.some((at) => time >= at && time - at <= LABEL_RUN_WINDOW_MS)
  );
}

/**
 * A run the forge created right after a label write, whatever its attempt: the
 * forge keeps a run's creation time across re-runs, so the provenance outlives
 * the re-run that answers for it.
 */
function labelStarted(run: WorkflowRun, writes: readonly number[]): boolean {
  return afterWrite(parseMs(run.createdAt), writes);
}

/**
 * The orphaned runs a label write cancelled: a label-started run itself, on its
 * attempt the write started, and any run of the same workflow whose latest attempt was in
 * flight when a label-started run was created (it began no later and ended no
 * earlier), which that run's arrival cancelled under the workflow's
 * concurrency group. A run that names no end time is never read as in flight.
 * A re-run of either starts a new attempt, so the same label write never
 * answers for it twice.
 */
export function labelCancelledRuns(
  orphaned: readonly WorkflowRun[],
  runs: readonly WorkflowRun[],
  writes: readonly number[],
): WorkflowRun[] {
  const started = runs.filter((run) => labelStarted(run, writes));
  return orphaned.filter((run) =>
    started.some(
      (label) =>
        label.workflowId === run.workflowId &&
        // Only the first attempt is the one the write started; a later attempt
        // was requested afterwards. Any other run is a victim only when the
        // label-started run arrived while it was in flight.
        (label.id === run.id
          ? run.attempt === 1
          : inFlightAt(run, parseMs(label.createdAt))),
    ),
  );
}

function inFlightAt(run: WorkflowRun, at: number): boolean {
  return (
    run.updatedAt !== undefined &&
    at >= parseMs(run.startedAt) &&
    parseMs(run.updatedAt) >= at
  );
}

/** What a label-caused re-run is claimed under: the run and the attempt it re-runs. */
export function labelRerunKey(
  run: Pick<WorkflowRun, "id" | "attempt">,
): string {
  return `${run.id}:${run.attempt}`;
}
