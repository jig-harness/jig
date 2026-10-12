/** The registered issue trackers, by the name configuration uses. */
import type { Tracker, TrackerOptions } from "../tracker.ts";
import { linearTracker } from "./linear.ts";

const TRACKERS = new Map<string, (options: TrackerOptions) => Tracker>([
  ["linear", (options) => linearTracker(options)],
]);

export function trackerNames(): string[] {
  return [...TRACKERS.keys()];
}

export function getTracker(name: string, options: TrackerOptions): Tracker {
  const make = TRACKERS.get(name);
  if (make === undefined)
    throw new Error(
      `unknown tracker "${name}" (available: ${trackerNames().join(", ")})`,
    );
  return make(options);
}
