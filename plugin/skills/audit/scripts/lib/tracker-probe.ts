/**
 * Whether config-fit can ask the configured tracker anything.
 */

import type { TrackerConfig } from "../../../do-item/scripts/lib/tracker/config.ts";
import { issueKeysOf } from "../../../do-item/scripts/lib/tracker/keys.ts";

/**
 * `false` when the tracker's key shape is unknown (a Linear tracker with no
 * team): then there is no team to ask about, and nothing to probe.
 */
export function trackerProbeable(config: TrackerConfig): boolean {
  return issueKeysOf(config, () => null) !== null;
}
