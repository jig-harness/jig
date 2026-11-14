/** One outage notice per native scope, retaining every repository's aged evidence. */
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { RepoReport, Unplaced } from "../types.ts";
import type { ServedView } from "./served-reads.ts";
import { isoFromMs } from "../../../shared/time.ts";

export function scopeFailureRow(
  tracker: Pick<Tracker, "adapter" | "team">,
  view: Pick<ServedView, "scope" | "readAt">,
  reason: string,
): Unplaced {
  const age =
    view.readAt > 0
      ? `the queue shown is the reading of ${isoFromMs(view.readAt)}`
      : "no kept queue reading";
  return {
    target: `${tracker.adapter} ${tracker.team}`,
    record: "tracker",
    reason: `${reason}; ${age}`,
    ...(view.scope === undefined ? {} : { scopeFailure: view.scope }),
  };
}

/** Keep the outage's one notice while each repository reports the reading it used. */
export function dropRepeatedScopeFailures(
  reports: readonly RepoReport[],
): void {
  const seen = new Set<string>();
  for (const report of reports)
    report.unplaced = report.unplaced.filter((row) => {
      if (row.scopeFailure === undefined) return true;
      const reading = report.records.find(
        (record) => record.record === "tracker",
      );
      if (reading !== undefined && !reading.detail.includes(row.reason))
        reading.detail += `; ${row.reason}`;
      if (seen.has(row.scopeFailure)) return false;
      seen.add(row.scopeFailure);
      return true;
    });
}
