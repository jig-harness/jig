/**
 * The Linear adapter's facets. Linear keeps priority in its own priority
 * field, which the adapter reads and writes as it always has; type and size
 * are labels, and priority too where `issue_tracker.facets.priority` names
 * the label store. Linear has no issue types, and keeping size in its
 * estimate comes in a later release.
 */

import { defaultFacets, type Facets } from "./facets/config.ts";
import { type CoreTracker, withFacets } from "./facets/tracker.ts";
import { TrackerConfigError } from "./config-error.ts";
import { PRIORITY_NAMES } from "./facets/values.ts";
import type { Tracker } from "./port.ts";

export type { Facets } from "./facets/config.ts";
export type {
  CoreIssue,
  CorePoolIssue,
  CoreTracker,
} from "./facets/tracker.ts";

/** The Linear tracker its core makes, with `facets` (default: the adapter's defaults). */
export function linearFacets(
  core: CoreTracker,
  facets: Facets = defaultFacets("linear"),
): Tracker {
  const native = facets.priority.store === "native";
  // Linear's own priority numbers are written and read as they are, so a map
  // onto other numbers could not be honoured in either direction.
  if (native)
    for (const [i, name] of PRIORITY_NAMES.entries())
      if (facets.priority.map?.toTracker(name) !== String(i + 1))
        throw new TrackerConfigError(
          "issue_tracker.facets.priority.values",
          "issue_tracker.facets.priority.values cannot remap Linear's native priority, which is always urgent 1 to low 4; keep priority in labels to name other values",
        );
  return withFacets(core, facets, new Set(native ? ["priority"] : []));
}
