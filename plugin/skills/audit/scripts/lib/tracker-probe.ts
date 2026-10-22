/**
 * What config-fit asks the configured tracker for to see that it answers.
 */

import type { TrackerConfig } from "../../../do-item/scripts/lib/tracker/config.ts";
import { issueKeysOf } from "../../../do-item/scripts/lib/tracker/keys.ts";

/**
 * The tracker's first issue, in its key shape (`ENG-1`, `#1`), or `null`
 * when the shape is unknown (a Linear tracker with no team): then no key
 * names an issue, and there is nothing to ask.
 */
export function trackerProbeKey(config: TrackerConfig): string | null {
  const keys = issueKeysOf(config);
  if (keys === null) return null;
  return keys.normalize("1") ?? keys.normalize(`${config.team}-1`);
}
