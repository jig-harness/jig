/** Plan a copy from live representations and its durable copy snapshot. */
import type { Facet } from "../../../do-item/scripts/lib/tracker/port.ts";
import type { ResolvedFacet } from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import { fold } from "../../../do-item/scripts/lib/tracker/facets/values.ts";
import type { MoveSides, Pair } from "./move.ts";
import type { FacetValue } from "./move-record.ts";
import { sourceValues, facetValue } from "./move-values.ts";

interface FacetPlan {
  gets?: FacetValue;
  copied?: string;
  set?: string;
  replaces?: string;
  unresolved?: string;
  conflict?: string;
}

/** Plan one facet against its live source, destination and recorded snapshot. */
function facetPlan(
  pair: Pair,
  f: Facet,
  sides: MoveSides,
  snap: FacetValue | undefined,
): FacetPlan {
  const d = facetValue(pair.dst, f);
  const problem = destinationProblem(
    pair,
    f,
    sides.targetFacets[f] as ResolvedFacet,
  );
  if (problem !== null) return { unresolved: problem };
  if (snap !== undefined)
    return d === snap
      ? {}
      : {
          conflict: `${f}: destination changed since the recorded copy; left untouched`,
        };
  const values = sourceValues(
    sides.sourceFacets[f] as ResolvedFacet,
    pair.src,
    f,
  );
  if (values.length > 1)
    return {
      unresolved: `${f} has two values in its source (${values.join(", ")})`,
    };
  const v = values[0];
  if (v === undefined)
    return {
      gets: d,
      ...(missingSourceRequired(pair, f, d, sides)
        ? { unresolved: `${f} has no value in its source` }
        : {}),
    };
  if (d === v) return { gets: v, copied: v };
  return { gets: v, copied: v, set: v, ...(d === null ? {} : { replaces: d }) };
}

/** Assemble one issue's plan without losing facet-specific conflict reasons. */
export function copyPlan(
  pair: Pair,
  moved: Facet[],
  sides: MoveSides,
  snapshotOf?: Partial<Record<Facet, FacetValue>>,
) {
  const gets: Partial<Record<Facet, FacetValue>> = {};
  const copied: Partial<Record<Facet, FacetValue>> = {};
  const set: Partial<Record<Facet, FacetValue>> = {};
  const replaces: Partial<Record<Facet, FacetValue>> = {};
  const unresolved: string[] = [],
    conflicts: string[] = [];
  for (const f of moved) {
    const p = facetPlan(pair, f, sides, snapshotOf?.[f]);
    if (p.gets !== undefined) gets[f] = p.gets;
    if (p.copied !== undefined) copied[f] = p.copied;
    if (p.set !== undefined) set[f] = p.set;
    if (p.replaces !== undefined) replaces[f] = p.replaces;
    if (p.unresolved !== undefined) unresolved.push(p.unresolved);
    if (p.conflict !== undefined) conflicts.push(p.conflict);
  }
  return { gets, copied, set, replaces, unresolved, conflicts };
}

/** A destination must have a losslessly restorable representation. */
export function destinationProblem(
  pair: Pair,
  f: Facet,
  slot: ResolvedFacet,
): string | null {
  if (sourceValues(slot, pair.dst, f).length > 1)
    return `${f} has two values in its destination; settle it before moving`;
  if (pair.dst.unmappedFacets?.includes(f))
    return `${f} has an unmapped destination value; map it before moving`;
  return null;
}

/** An epic may omit size when neither store carries it. */
function missingSourceRequired(
  pair: Pair,
  f: Facet,
  destination: FacetValue,
  sides: MoveSides,
): boolean {
  if (destination !== null) return false;
  const epicSize =
    f === "size" &&
    pair.src.labels.some((l) => fold(l) === fold(sides.sourceFacets.epic));
  return !epicSize;
}
