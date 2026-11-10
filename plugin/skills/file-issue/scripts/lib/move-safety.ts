/** Preconditions of a facet move: distinct stores and unchanged live issues. */
import {
  type ResolvedFacet,
  usable,
} from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import { fold } from "../../../do-item/scripts/lib/tracker/facets/values.ts";
import type { MoveSides, Pair } from "./move.ts";
import { sourceValues, facetValue, carriedLabels } from "./move-values.ts";
import type {
  Facet,
  PoolIssue,
} from "../../../do-item/scripts/lib/tracker/port.ts";

/** Why one facet's source cannot be retired into its destination, or `null`. */
function retireProblem(sides: MoveSides, f: Facet): string | null {
  const a = sides.sourceFacets[f],
    b = sides.targetFacets[f];
  if (!usable(a) || !usable(b)) return `${f}: both stores must be usable`;
  if (sides.source.adapter === "jira" && a.store === "native")
    return `${f}: every Jira issue keeps its native ${f === "type" ? "issue type" : f}; moving it cannot retire the source`;
  if (fallbackOverlap(a, b))
    return `${f}: Jira's issue type keeps a sub-task's type, and a type with no issue type of its own, in the type labels, so they cannot be retired; name the store without a move, since a type label wins over the fallback issue type`;
  return null;
}

export function moveProblem(sides: MoveSides, moved: Facet[]): string | null {
  for (const f of moved) {
    const problem = retireProblem(sides, f);
    if (problem !== null) return problem;
  }
  // Every destination must preserve every source, including unmoved facets.
  const sources = [
    sides.sourceFacets.type,
    sides.sourceFacets.priority,
    sides.sourceFacets.size,
  ].filter(usable);
  for (const f of moved) {
    const b = sides.targetFacets[f] as ResolvedFacet;
    if (sources.some((a) => physicalOverlap(a, b, sides.source.adapter)))
      return `${f}: source and destination overlap in the same physical store; an in-place mapping change is not a move`;
    if (sources.some((a) => labelsOverlap(a, b)))
      return `${f}: source and destination label stores overlap`;
  }
  const targets = [
    sides.targetFacets.type,
    sides.targetFacets.priority,
    sides.targetFacets.size,
  ].filter(usable);
  for (const f of moved) {
    const target = sides.targetFacets[f] as ResolvedFacet;
    if (
      targets.some(
        (other) =>
          other.facet !== f &&
          (physicalOverlap(target, other, sides.target.adapter) ||
            labelsOverlap(target, other)),
      )
    )
      return `${f}: destination stores overlap; one physical store cannot hold two facets`;
  }
  return null;
}

/** Normalize native aliases before comparing physical storage across facets. */
function physicalOverlap(
  a: ResolvedFacet,
  b: ResolvedFacet,
  adapter: string,
): boolean {
  const identity = (s: ResolvedFacet) => {
    if (s.store === "label") return null;
    if (s.store === "field") return `field:${fold(s.field ?? "")}`;
    return adapter === "github" && s.facet === "priority"
      ? "field:priority"
      : `native:${s.facet}`;
  };
  const ai = identity(a);
  return ai !== null && ai === identity(b);
}

/** Re-read after pacing and before every effect, including retries. Trackers without compare-and-set still have a last-read/write race. */
export async function assertUnchanged(
  sides: MoveSides,
  expected: Pair,
  only?: "source" | "target",
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const src = await sides.source.poolIssue(expected.key, signal);
  signal?.throwIfAborted();
  const dst = await sides.target.poolIssue(expected.key, signal);
  signal?.throwIfAborted();
  const stamp = (i: PoolIssue, side: "source" | "target") => {
    const facets = side === "source" ? sides.sourceFacets : sides.targetFacets;
    return JSON.stringify([
      i.state,
      i.truncated,
      ["type", "priority", "size"].map((f) => {
        const facet = f as Facet,
          slot = facets[facet];
        return usable(slot)
          ? [
              sourceValues(slot, i, facet).sort((a, b) => a.localeCompare(b)),
              carriedLabels(slot, i, facetValue(i, facet)).sort((a, b) =>
                a.localeCompare(b),
              ),
            ]
          : facetValue(i, facet);
      }),
      i.unmappedFacets ?? [],
    ]);
  };
  if (
    src === null ||
    dst === null ||
    !["backlog", "unstarted", "triage", "started"].includes(src.state.type) ||
    (only !== "target" &&
      stamp(src, "source") !== stamp(expected.src, "source")) ||
    (only !== "source" &&
      stamp(dst, "target") !== stamp(expected.dst, "target"))
  ) {
    const error = new Error(
      "the issue changed since planning; left untouched, run again to replan",
    );
    error.name = "MoveConflict";
    throw error;
  }
}

/** Whether a destination keeps values in the source's labels where it cannot keep them itself (Jira's issue type). */
function fallbackOverlap(a: ResolvedFacet, b: ResolvedFacet): boolean {
  if (a.store !== "label" || b.fallback === undefined) return false;
  const labels = new Set((a.labels ?? []).flatMap(([, ls]) => ls.map(fold)));
  return b.fallback.some(([, ls]) => ls.some((l) => labels.has(fold(l))));
}

function labelsOverlap(
  a: import("../../../do-item/scripts/lib/tracker/facets/config.ts").ResolvedFacet,
  b: typeof a,
): boolean {
  if (a.store !== "label" || b.store !== "label") return false;
  const labels = new Set((a.labels ?? []).flatMap(([, ls]) => ls.map(fold)));
  return (b.labels ?? []).some(([, ls]) => ls.some((l) => labels.has(fold(l))));
}
