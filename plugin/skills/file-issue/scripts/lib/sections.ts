/**
 * The `issue_tracker.facets` sections the sweep and the move read: the one
 * in force (the configuration's, each facet it leaves out named by the store
 * `facetStores` reports), a target given as a file, the tracker
 * configuration with a section put in place of the repository's, and the
 * labels a facet kept outside labels has retired.
 */

import { readFileSync } from "node:fs";
import { isRecord } from "../../../../shared/guards.ts";
import { load } from "../../../../shared/yaml.ts";
import {
  facetsOf,
  type TrackerConfig,
  trackerConfigFrom,
} from "../../../do-item/scripts/lib/tracker/config.ts";
import {
  type FacetEntries,
  type FacetEntry,
  type Facets,
  type FacetSlot,
  parseFacetEntries,
  usable,
} from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import {
  FACETS,
  type FacetStores,
} from "../../../do-item/scripts/lib/tracker/port.ts";

/** A section or file the move cannot take. */
export class SectionError extends Error {}

/** The tracker configuration of `overlay` with `section` as its `issue_tracker.facets`. */
export function withSection(
  overlay: Record<string, unknown>,
  section: FacetEntries,
): TrackerConfig {
  const tracker = isRecord(overlay.issue_tracker) ? overlay.issue_tracker : {};
  return trackerConfigFrom({
    ...overlay,
    issue_tracker: { ...tracker, facets: section },
  });
}

/**
 * The section in force: each facet the configuration names as written, and
 * each other one by the store `stores` reports for it. Throws for a facet
 * with no store (in conflict, or unreadable): the move cannot say what it
 * moves from.
 */
export function sectionInForce(
  config: TrackerConfig,
  stores: FacetStores,
): FacetEntries {
  const out: FacetEntries = {};
  for (const report of stores.facets) {
    const f = report.facet;
    const named = config.facets[f];
    if (named !== undefined) {
      out[f] = named;
      continue;
    }
    if (report.why === "no facet" && report.problem === undefined) continue;
    if (report.store === null)
      throw new SectionError(
        `${f} has no store in force (${report.problem ?? report.why}): name one in issue_tracker.facets before moving it`,
      );
    const entry: FacetEntry = { store: report.store };
    if (report.store === "field" && report.field !== undefined)
      entry.field = report.field;
    out[f] = entry;
  }
  return out;
}

/**
 * The target section in `path`: a YAML file holding the section itself, or
 * `issue_tracker: { facets: … }`. It names every facet the repository has,
 * so the switch commits every store.
 */
export function readTarget(
  path: string,
  adapter: string,
  facets: Facets,
): FacetEntries {
  let raw: unknown;
  try {
    raw = load(readFileSync(path, "utf8"));
  } catch (err) {
    throw new SectionError(
      `the target ${path} cannot be read as YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
  }
  const section =
    isRecord(raw) && isRecord(raw.issue_tracker)
      ? raw.issue_tracker.facets
      : raw;
  const entries = parseFacetEntries(section, adapter);
  const unnamed = FACETS.filter(
    (f) => usable(facets[f]) && entries[f] === undefined,
  );
  if (unnamed.length > 0)
    throw new SectionError(
      `the target ${path} names no store for ${unnamed.join(", ")}: it is the section the repository commits, so it names every facet's store`,
    );
  return entries;
}

/**
 * The labels each facet kept outside labels has retired: those its label
 * store would keep it in, which an open issue no longer carries once the
 * repository has moved.
 */
export function retiredLabels(
  overlay: Record<string, unknown>,
  config: TrackerConfig,
  root: string,
  stores: FacetStores,
): string[] {
  const out: string[] = [];
  for (const report of stores.facets) {
    if (report.store === null || report.store === "label") continue;
    let slot: FacetSlot;
    try {
      slot = facetsOf(
        withSection(overlay, {
          ...config.facets,
          [report.facet]: { store: "label" },
        }),
        root,
      )[report.facet];
    } catch {
      continue;
    }
    if (usable(slot))
      for (const [, labels] of slot.labels ?? []) out.push(...labels);
  }
  return [...new Set(out)];
}

/** Where a slot keeps its facet, for a line of the report. */
export function storeName(slot: FacetSlot): string {
  if (!usable(slot)) return "no store";
  if (slot.store === "field") return `the ${slot.field} field`;
  return slot.store === "native" ? "the tracker's own field" : "labels";
}
