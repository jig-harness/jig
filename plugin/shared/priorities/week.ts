/**
 * The week's allocation counters
 * ([design](../../../design/priorities-and-overview.md#computed-ranking-proposes-a-shortlist)).
 * A week is a UTC week from Monday 00:00, named by that Monday's date. The
 * counters are derived from the week's charges: `N` the weighted starts, `P`
 * the peripheral starts and `F` the floor entitlement, the sum of the
 * peripheral share recorded with each weighted charge (so a weight changed
 * during the week never rewrites a past start). At a week boundary the next
 * week's opening debt is `max(0, F - max(0, P - D0))`: it replaces, never
 * adds to, the opening debt.
 */
import { isoFromMs, parseMs } from "../time.ts";
import { isWeightedLane, type Lane } from "./lanes.ts";

const DAY_MS = 86_400_000;

/** One start as the counters read it, in claim order. */
export interface WeekCharge {
  claimId: string;
  lane: Lane | "unallocated";
  /** The repository-level allocation owner, for the in-lane objective counters. */
  objective: string | null;
  /** The peripheral lane's share when the start was charged. */
  peripheralShare: number;
  atMs: number;
}

/** A completed week's row, written once by the first tick of the next week. */
export interface WeekRow {
  week: string;
  n: number;
  p: number;
  d0: number;
  f: number;
  nextDebt: number;
  /** Why the debt is what it is, when there was nothing to derive it from. */
  reason: string | null;
}

/** The Monday (UTC) of the week holding `ms`, as `YYYY-MM-DD`. */
export function weekOf(ms: number): string {
  return isoFromMs(weekStartMs(ms)).slice(0, 10);
}

/** The first millisecond of the UTC week holding `ms`. */
export function weekStartMs(ms: number): number {
  const day = Math.floor(ms / DAY_MS);
  // 1970-01-01 was a Thursday: Monday is three days before day 0's week.
  const monday = Math.floor((day + 3) / 7) * 7 - 3;
  return monday * DAY_MS;
}

/** The week before `week`. */
export function previousWeek(week: string): string {
  return weekOf(parseMs(`${week}T00:00:00.000Z`) - DAY_MS);
}

/** Whether a charge counts toward `N`: a weighted lane's start. */
export function isWeighted(charge: WeekCharge): boolean {
  return isWeightedLane(charge.lane);
}

/** A completed week's row from its charges and its opening debt. */
export function closeWeek(
  week: string,
  charges: readonly WeekCharge[],
  d0: number,
  d0Reason: string | null = null,
): WeekRow {
  const weighted = charges.filter(isWeighted);
  const n = weighted.length;
  const p = weighted.filter((c) => c.lane === "peripheral").length;
  const f = weighted.reduce((sum, c) => sum + c.peripheralShare, 0);
  const nextDebt = clean(Math.max(0, f - Math.max(0, p - d0)));
  return {
    week,
    n,
    p,
    d0,
    f: clean(f),
    nextDebt,
    reason:
      n === 0
        ? d0Reason === null
          ? "no weighted starts were charged that week"
          : d0Reason
        : null,
  };
}

/** Drop floating-point noise below a millionth of a start. */
export function clean(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
