/** Coverage and whole-population verdict rules shared by aggregation and rendering. */
import { METRICS, type MetricSpec, verdictOf } from "./fractal-baseline.ts";
import type { PrSide } from "./fractal.ts";

/**
 * The least share of eligible threads that must be blameable before the
 * self-inflicted share is judged at all. Below it the measured threads are the
 * ones whose heads happened to be local — a biased subset — and a verdict read
 * off them would be confidently wrong, so the metric is `not-measured`.
 */
export const MIN_SELF_INFLICTED_COVERAGE = 0.9;

/**
 * The late-round share over threads with a known round, or `null` when the
 * unknown-round threads could move the verdict.
 *
 * The baseline divides by ALL threads, so the comparable figure lies somewhere
 * in `[late/all, (late+unknown)/all]` — every unknown thread early, or every
 * one late. The share is judged only when both ends of that interval read the
 * same verdict; a coverage floor alone would let a few unknown threads cross a
 * tolerance edge.
 */
export function judgedLateRoundShare(
  pr: PrSide,
  specs: ReadonlyArray<MetricSpec> = METRICS,
): number | null {
  const l = pr.lateRoundThreadShare;
  const spec = specs.find((m) => m.id === "late_round_thread_share");
  if (l.share === null || spec === undefined) return null;
  const all = l.total + pr.threads.unknownRound;
  const low = l.late / all;
  const high = (l.late + pr.threads.unknownRound) / all;
  return verdictOf(spec, low) === verdictOf(spec, high) ? l.share : null;
}

/**
 * The self-inflicted headline share, or `null` when coverage is below
 * `MIN_SELF_INFLICTED_COVERAGE` — the one rule both the verdict and the report
 * apply, so the table never prints a figure the verdict has withheld.
 */
export function judgedSelfInflictedShare(
  pr: PrSide,
  specs: ReadonlyArray<MetricSpec> = METRICS,
): number | null {
  const si = pr.selfInflicted;
  const spec = specs.find((m) => m.id === "self_inflicted_share");
  if (si.coverage === null || si.coverage < MIN_SELF_INFLICTED_COVERAGE) {
    return null;
  }
  if (si.share === null || spec === undefined) return null;
  // The baseline divides by every eligible thread, so the comparable figure
  // lies in `[selfInflicted/eligible, (selfInflicted+unmeasured)/eligible]`.
  // Same rule as `judgedLateRoundShare`: judged only when both ends agree, so
  // the coverage floor alone cannot let unmeasured threads flip the verdict.
  const unmeasured = si.eligible - si.measured;
  const low = si.selfInflicted / si.eligible;
  const high = (si.selfInflicted + unmeasured) / si.eligible;
  return verdictOf(spec, low) === verdictOf(spec, high) ? si.share : null;
}

/**
 * Whether a per-cut (band or week) self-inflicted share may be printed: the
 * cut clears its own coverage floor AND the headline share is judged. A cut is
 * a slice of the headline's population, so it cannot be firmer than the
 * headline — one predicate for every cut kind keeps the table from printing a
 * figure for a population whose verdict the headline has withheld.
 */
export function cutShareIsPublishable(
  pr: PrSide,
  cut: { coverage: number | null },
  specs: ReadonlyArray<MetricSpec> = METRICS,
): boolean {
  return (
    judgedSelfInflictedShare(pr, specs) !== null &&
    cut.coverage !== null &&
    cut.coverage >= MIN_SELF_INFLICTED_COVERAGE
  );
}
