/**
 * Open the consumer's issue tracker: read `issue_tracker` from the overlay and
 * hand it to the adapter it names. Callers import from here and use the
 * `Tracker` port; they never import an adapter.
 *
 * To add a tracker: implement `Tracker` in a sibling module and register a
 * factory in `ADAPTERS`. No caller changes.
 */

import {
  parseTrackerConfig,
  requireTeamKey,
  type TrackerConfig,
} from "./config.ts";
import { readOverlay } from "../../../../resolve-review-comments/scripts/lib/consumer.ts";
import { defaultTransport, linearTracker } from "./linear.ts";
import type { Tracker } from "./port.ts";

export type { CanonicalState, Tracker } from "./port.ts";
export { CANONICAL_STATES } from "./port.ts";

type AdapterFactory = (config: TrackerConfig & { team: string }) => Tracker;

const ADAPTERS: Record<string, AdapterFactory> = {
  linear: (config) =>
    linearTracker({
      team: config.team,
      states: config.states,
      transport: defaultTransport(),
    }),
};

/** The adapters this version knows, by `issue_tracker.adapter` name. */
export function knownAdapters(): string[] {
  return Object.keys(ADAPTERS);
}

/**
 * The tracker the consumer configured. Throws with the field to fix when the
 * overlay is missing, names an unknown adapter, or declares no team.
 */
export function openTracker(
  config: TrackerConfig = parseTrackerConfig(readOverlay()),
): Tracker {
  const factory = Object.hasOwn(ADAPTERS, config.adapter)
    ? ADAPTERS[config.adapter]
    : undefined;
  if (factory === undefined)
    throw new Error(
      `issue_tracker.adapter '${config.adapter}' is not supported (known: ${knownAdapters().join(", ")})`,
    );
  return factory({ ...config, team: requireTeamKey(config) });
}
