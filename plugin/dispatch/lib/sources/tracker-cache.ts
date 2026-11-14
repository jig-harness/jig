/** Opaque credentials keep readings in this process; identified credentials may reuse durable readings. */
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
const trackers = new WeakMap<Tracker, PickupReads>();
function memoryReads(): PickupReads {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (values.get(key) as T) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

/** Every pickup lane uses this selection before reading or writing tracker facts. */
export function cacheForTracker(
  tracker: Tracker,
  durable: PickupReads,
): PickupReads {
  if (tracker.dispatchSource?.persistent !== false) return durable;
  const cache = trackers.get(tracker) ?? memoryReads();
  trackers.set(tracker, cache);
  return cache;
}
