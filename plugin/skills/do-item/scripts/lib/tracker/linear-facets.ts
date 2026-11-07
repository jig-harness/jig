/**
 * The Linear adapter's facets. Linear keeps priority in its own priority
 * field, which the adapter reads and writes as it always has; type and size
 * are labels, and priority too where `issue_tracker.facets.priority` names
 * the label store. Linear has no issue types, and keeping size in its
 * estimate comes in a later release.
 */

import { defaultFacets, type Facets } from "./facets/config.ts";
import { type CoreTracker, withFacets } from "./facets/tracker.ts";
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
  return withFacets(core, facets, new Set(native ? ["priority"] : []));
}
