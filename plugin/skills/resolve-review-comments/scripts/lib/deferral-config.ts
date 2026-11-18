import { isRecord } from "../../../../shared/guards.ts";
import { JigError } from "../../../../shared/outcome.ts";
import {
  parseTrackerConfig,
  type TrackerConfig,
} from "../../../do-item/scripts/lib/tracker/config.ts";

/** Resolve the filing team's command override before validating the tracker configuration. */
export function deferralTrackerConfig(
  values: Record<string, unknown>,
  review: { deferral_team?: string },
  requested?: string,
): TrackerConfig {
  const raw = values.issue_tracker;
  if (raw !== undefined && raw !== null && !isRecord(raw))
    return parseTrackerConfig(values);
  const tracker = isRecord(raw) ? raw : {};
  const adapter = tracker.adapter ?? "github";
  if (requested !== undefined && adapter !== "linear")
    throw new JigError(
      "deferral",
      "--team only applies to Linear; use issue_tracker configuration for another adapter",
    );
  const team = requested ?? review.deferral_team;
  if (adapter !== "linear" || team === undefined)
    return parseTrackerConfig(values);
  return parseTrackerConfig({ ...values, issue_tracker: { ...tracker, team } });
}
