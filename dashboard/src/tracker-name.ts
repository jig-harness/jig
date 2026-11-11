/**
 * The name the page gives a repository's tracker, from the adapter its
 * configuration names (`LineRepo.tracker`): the product a person knows,
 * not the configuration's word for it.
 */
import type { LineRepo } from "../../plugin/dispatch/lib/dashboard-contract.ts";

/** The trackers Jig has an adapter for, by the adapter's name. */
const NAMES: Readonly<Record<string, string>> = {
  github: "GitHub Issues",
  linear: "Linear",
  jira: "Jira",
};

/** A tracker's name for a person; an adapter the page does not know by its own word; `null` when the line does not say. */
export function trackerName(tracker: LineRepo["tracker"]): string | null {
  if (tracker == null) return null;
  const adapter = tracker.adapter.toLowerCase();
  return Object.hasOwn(NAMES, adapter)
    ? (NAMES[adapter] ?? tracker.adapter)
    : tracker.adapter;
}
