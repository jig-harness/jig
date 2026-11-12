/**
 * The issue facets in the tick's tracker record: where the tracker keeps
 * each item's type, priority and size and why (`Tracker.facetStores`,
 * without the organization's discovery), whether detection answered from
 * its cache, and the assigned items that lack a facet the repository keeps.
 *
 * The dispatcher starts only what a trusted person assigned, so a missing
 * facet holds nothing back; it is counted here, so a store that fails or
 * changes, or an item filed around the filing check, is seen on the next
 * tick. The record names keys and facets only, never an item's content.
 *
 * The facet read runs inside the tick, so it is bounded: by the tick's own
 * deadline where its launcher sets one, and by `FACET_READ_MS` in any case,
 * through a signal that stops the request in flight and starts no other.
 * A facet read that fails or is stopped is one line on the record; the
 * pickups are read whatever it answered.
 */
import type {
  Facet,
  FacetStores,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { failureText } from "../text.ts";
import type { FacetRecord, FacetStoreLine } from "../types.ts";

/**
 * The most one repository's facet read may take. Detection and the store
 * checks are a few requests, each bounded by the tracker's own timeout
 * (30 seconds on GitHub); twice that leaves room for two in a row and
 * keeps a tracker that stopped answering from holding the observe phase.
 */
export const FACET_READ_MS = 60_000;

/** A failure line on the record: one line, at most 300 characters. */
const line = (text: string) => text.slice(0, 300);

/** How a facet read is stopped: the deadline it may not pass, and the signal that ends it there. */
export interface FacetBound {
  /** Epoch milliseconds. */
  deadline: number;
  signal: AbortSignal;
}

/**
 * The bound of a facet read starting now: `FACET_READ_MS` from now, or the
 * tick's own deadline (`tickDeadline`, epoch milliseconds) when it is sooner.
 */
export function facetBound(
  tickDeadline: number | undefined,
  now = Date.now(),
): FacetBound {
  const deadline = Math.min(tickDeadline ?? Infinity, now + FACET_READ_MS);
  return {
    deadline,
    signal: AbortSignal.timeout(Math.max(0, deadline - now)),
  };
}

/**
 * The part of `bound` the diagnostic store report may use: the first half
 * of what is left, ended by `bound`'s own signal too, so the assigned-item
 * read that follows keeps the other half.
 */
export function reportBound(bound: FacetBound, now = Date.now()): FacetBound {
  const deadline = now + Math.max(0, bound.deadline - now) / 2;
  return {
    deadline,
    signal: AbortSignal.any([
      bound.signal,
      AbortSignal.timeout(Math.max(0, deadline - now)),
    ]),
  };
}

/** Each facet's line from the tracker's report. */
function storeLines(report: FacetStores): FacetStoreLine[] {
  return report.facets.map((f) => {
    const errors = [
      f.problem,
      f.health?.status === "failed" ? f.health.error : undefined,
      f.detection?.status === "failed" ? f.detection.error : undefined,
    ].filter((e): e is string => e !== undefined);
    const cached =
      f.detection?.status === "read" && f.detection.cached === true;
    return {
      facet: f.facet,
      store: f.store,
      why: f.why,
      ...(cached ? { cached: true as const } : {}),
      ...(errors.length === 0 ? {} : { error: line(errors.join("; ")) }),
    };
  });
}

/**
 * Where the tracker keeps each facet, read within `bound`; or why it did
 * not say. Never throws: a failed or stopped read is the record's line.
 */
export async function readFacetStores(
  tracker: Tracker,
  bound: FacetBound,
): Promise<FacetRecord> {
  if (bound.signal.aborted || Date.now() >= bound.deadline)
    return {
      failed:
        "not read: the tick's deadline passed before the facet read could start",
    };
  try {
    const report = await tracker.facetStores({
      discovery: false,
      signal: bound.signal,
      deadline: bound.deadline,
    });
    return { stores: storeLines(report) };
  } catch (error) {
    const stopped = bound.signal.aborted || Date.now() >= bound.deadline;
    return {
      failed: line(
        stopped
          ? `stopped at the tick's deadline: ${failureText(error)}`
          : failureText(error),
      ),
    };
  }
}

/** Whether an item lacks `facet`; an epic needs no size. */
function lacks(issue: PoolIssue, facet: Facet): boolean {
  if (facet === "priority") return issue.priority === 0;
  if (facet === "size" && issue.isEpic) return false;
  return issue[facet] === null;
}

/**
 * The assigned items that lack a facet the repository keeps: one with a
 * store in `stores`. A facet with no store (none, or in conflict) asks
 * nothing; with no stores read, no item is a gap.
 */
export function facetGaps(
  issues: ReadonlyArray<PoolIssue>,
  stores: ReadonlyArray<FacetStoreLine>,
): Array<{ key: string; missing: Facet[] }> {
  const kept = stores.filter((s) => s.store !== null).map((s) => s.facet);
  return issues
    .map((i) => ({
      key: i.identifier,
      missing: kept.filter((f) => lacks(i, f)),
    }))
    .filter((g) => g.missing.length > 0);
}

/** The record's sentence about the facets, for the read's detail. */
export function facetSummary(record: FacetRecord): string {
  if (record.failed !== undefined)
    return "where the facets are kept was not read";
  const gaps = record.gaps?.length ?? 0;
  return gaps === 0
    ? "every assigned item carries its facets"
    : `${gaps} assigned item(s) lack a type, priority or size`;
}
