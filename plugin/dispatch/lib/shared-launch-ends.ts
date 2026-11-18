/** The launch's outcome as other hosts may read it on the forge. */
import type { ReportCause, ReportWriter } from "../../shared/closing-report.ts";
import type { LaunchEnd } from "../../shared/records/shared.ts";
import { outcomeOf } from "./followup-outcomes.ts";
import {
  cancelledBeforeExecution,
  holds,
  type ReadRecord,
} from "./launches.ts";
import { pendingRearm } from "./rearm-state.ts";
import { releaseHandoffTags } from "./release-needs.ts";

/** How a launch record's launch ended, as its claim says it; `null` while it holds. */
export function endOfRecord(
  r: ReadRecord | undefined,
  nowIso: string,
): LaunchEnd | null {
  if (r === undefined)
    return {
      state: "died",
      at: nowIso,
      reason: "its launch record is gone from the host that made it",
    };
  if (cancelledBeforeExecution(r))
    return {
      state: "died",
      at: r.record.cancelledAt ?? nowIso,
      reason: "its reservation was cancelled before execution",
      executed: false,
    };
  // Other hosts must retain the reservation until the request label is removed.
  if (holds(r.state) || pendingRearm(r.record, r.state)) return null;
  if (r.state.kind === "died")
    return { state: "died", at: nowIso, reason: r.state.reason };
  if (r.state.kind !== "ended") return null;
  const outcome = r.record.action === "followup" ? outcomeOf(r) : null;
  return {
    state: "ended",
    at: r.state.exit.at,
    exit: r.state.exit.code,
    outcome,
    ...reportOfRun(r),
  };
}

/** What an end says of the run's closing report: who wrote it and its cause, never its text, since the claim is public. */
export function reportOfRun(r: ReadRecord): {
  by: ReportWriter;
  cause?: ReportCause;
} {
  const kept = r.report ?? null;
  if (kept === null) return { by: "none" };
  const { cause } = kept.report;
  return cause === undefined ? { by: kept.by } : { by: kept.by, cause };
}

export function withReleaseHandoff<T extends LaunchEnd | null>(
  end: T,
  repo: string,
  launch: string,
  root?: string,
): T {
  if (end?.state !== "ended" || end.outcome === null) return end;
  const releaseTags = releaseHandoffTags(repo, launch, root);
  return releaseTags.length === 0 ? end : { ...end, releaseTags };
}
