/** Preconditions of a facet move: distinct stores and unchanged live issues. */
import { usable } from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import { fold } from "../../../do-item/scripts/lib/tracker/facets/values.ts";
import type { MoveSides, Pair } from "./move.ts";
import { sourceValues, facetValue, carriedLabels } from "./move-values.ts";
import type {
  Facet,
  PoolIssue,
} from "../../../do-item/scripts/lib/tracker/port.ts";

export function moveProblem(sides: MoveSides, moved: Facet[]): string | null {
  for (const f of moved) {
    const a = sides.sourceFacets[f],
      b = sides.targetFacets[f];
    if (!usable(a) || !usable(b)) return `${f}: both stores must be usable`;
    if (sides.source.adapter === "jira" && a.store === "native")
      return `${f}: Jira requires its native priority; moving it cannot retire the source`;
    const identity = (s: typeof a) =>
      s.store === "label"
        ? null
        : s.store === "field"
          ? `field:${fold(s.field ?? "")}`
          : sides.source.adapter === "github" && s.facet === "priority"
            ? "field:priority"
            : `native:${s.facet}`;
    const ai = identity(a),
      bi = identity(b);
    if (ai !== null && ai === bi)
      return `${f}: source and destination overlap in the same physical store; an in-place mapping change is not a move`;
    if (labelsOverlap(a, b))
      return `${f}: source and destination label stores overlap`;
  }
  return null;
}

/** Re-read after pacing and before every effect, including retries. Trackers without compare-and-set still have a last-read/write race. */
export async function assertUnchanged(
  sides: MoveSides,
  expected: Pair,
  only?: "source" | "target",
): Promise<void> {
  const src = await sides.source.poolIssue(expected.key);
  const dst = await sides.target.poolIssue(expected.key);
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
              sourceValues(slot, i, facet).sort(),
              carriedLabels(slot, i, facetValue(i, facet)).sort(),
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

function labelsOverlap(
  a: import("../../../do-item/scripts/lib/tracker/facets/config.ts").ResolvedFacet,
  b: typeof a,
): boolean {
  if (a.store !== "label" || b.store !== "label") return false;
  const labels = new Set((a.labels ?? []).flatMap(([, ls]) => ls.map(fold)));
  return (b.labels ?? []).some(([, ls]) => ls.some((l) => labels.has(fold(l))));
}
