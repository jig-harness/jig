/**
 * Whether config-fit can ask the configured tracker anything.
 */

import type { TrackerConfig } from "../../../do-item/scripts/lib/tracker/config.ts";
import { knownAdapters } from "../../../do-item/scripts/lib/tracker/index.ts";
import { issueKeysOf } from "../../../do-item/scripts/lib/tracker/keys.ts";

/**
 * `false` only when a known adapter's key shape is unknown (a Linear tracker
 * with no team): then there is no team to ask about, and nothing to probe.
 * An adapter this version does not know is probed, so that `openTracker`
 * refuses it as every skill does.
 */
export function trackerProbeable(config: TrackerConfig): boolean {
  return (
    !knownAdapters().includes(config.adapter) ||
    issueKeysOf(config, () => null) !== null
  );
}
