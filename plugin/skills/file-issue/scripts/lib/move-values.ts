/** Read the complete representation of one migration facet and construct its assignment. */
import { labelCodec } from "../../../do-item/scripts/lib/tracker/facets/label.ts";
import type { ResolvedFacet } from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import {
  priorityName,
  priorityNumber,
  type PriorityName,
} from "../../../do-item/scripts/lib/tracker/facets/values.ts";
import type {
  Facet,
  PoolIssue,
  IssuePatch,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import type { FacetValue } from "./move-record.ts";
/** An issue's value of a facet, a priority by its name. */
export function facetValue(issue: PoolIssue, f: Facet): FacetValue {
  return f === "priority" ? priorityName(issue.priority) : issue[f];
}

/** The patch that sets `f` to `v` (`null`: none). */
export function setting(f: Facet, v: FacetValue): IssuePatch {
  if (f === "priority")
    return { priority: v === null ? 0 : priorityNumber(v as PriorityName) };
  return { [f]: v };
}

/** Every value an issue's source representation of `f` names. */
export function sourceValues(
  slot: ResolvedFacet,
  issue: PoolIssue,
  f: Facet,
): string[] {
  const v = facetValue(issue, f);
  if (slot.store !== "label") return v === null ? [] : [v];
  const codec = labelCodec(slot);
  const found = new Set<string>();
  for (const l of [...issue.labels, ...(issue.hiddenLabels ?? [])]) {
    const x = codec.read([l]);
    if (x !== null) found.add(x);
  }
  // A label the adapter keeps out of `labels` (GitHub's priority labels).
  if (found.size === 0 && v !== null) found.add(v);
  return [...found];
}

/** The labels of `slot`'s store an issue carries, for the record. */
export function carriedLabels(
  slot: ResolvedFacet,
  issue: PoolIssue,
  value: FacetValue,
): string[] {
  if (slot.store !== "label") return [];
  const codec = labelCodec(slot);
  const visible = [...issue.labels, ...(issue.hiddenLabels ?? [])].filter((l) =>
    codec.owns(l),
  );
  return visible.length > 0 || value === null
    ? visible
    : [codec.labelOf(value)];
}
