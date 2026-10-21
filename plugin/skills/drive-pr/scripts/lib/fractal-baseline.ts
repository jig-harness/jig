/**
 * The scoreboard's metric catalogue: what `fractal-metrics.ts` measures, which
 * direction is better, how much movement counts as "flat", and the baseline
 * each is judged against.
 *
 * The baseline VALUES are the consumer's recorded facts, not this mechanism's:
 * they come from `baselines:` in the consumer's fleet-health configuration
 * (`lib/fleet-health-config.ts`), each with the document that records it and
 * a needle that must still appear there, so a number that has silently left
 * its own source is detectable (`baselineSourceProblems`). A metric without a
 * recorded baseline reports `no-baseline` rather than a verdict.
 *
 * `direction: null` is CONTEXT: a figure worth printing next to its baseline
 * that no verdict is issued for, because "better" is not well-defined for it.
 * The reason is stated at each entry that has it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricBaseline } from "./fleet-health-config.ts";

/** Which way is better. `null` = context only, no verdict. */
export type Direction = "lower" | "higher" | null;

/**
 * `relative`: flat while |now - baseline| <= tolerance * |baseline|.
 * `absolute`: flat while |now - baseline| <= tolerance (for shares, in
 * fractional points — 0.03 is three percentage points).
 */
export type ToleranceKind = "relative" | "absolute";

export type MetricUnit = "count" | "rate" | "share" | "days";

export interface MetricSource {
  /** Repo-relative path of the document that owns the baseline number. */
  file: string;
  /** A substring that must appear in `file` for the baseline to be cited. */
  needle: string;
}

export interface MetricSpec {
  id: string;
  label: string;
  side: "pr" | "linear";
  unit: MetricUnit;
  direction: Direction;
  toleranceKind: ToleranceKind;
  tolerance: number;
  /** `null` until a baseline is recorded — the verdict is then `no-baseline`. */
  baseline: number | null;
  /** Where the baseline is recorded. `null` only when `baseline` is `null`. */
  source: MetricSource | null;
}

export type Verdict =
  | "improved"
  | "flat"
  | "worse"
  | "context"
  | "no-baseline"
  | "not-measured";

export const METRICS: readonly MetricSpec[] = [
  // ── PR side — measured over merged PRs in the window ────────────────────
  {
    id: "merge_conflict_share",
    label: "Merged PRs that met a merge conflict",
    side: "pr",
    unit: "share",
    direction: "lower",
    toleranceKind: "absolute",
    tolerance: 0.03,
    baseline: null,
    source: null,
  },
  {
    id: "rounds_median",
    label: "Bot-reviewed heads per PR — median",
    side: "pr",
    unit: "count",
    direction: "lower",
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
  {
    id: "rounds_p90",
    label: "Bot-reviewed heads per PR — p90",
    side: "pr",
    unit: "count",
    direction: "lower",
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
  {
    // Bound to the ladder's `bands:` as they stood when the baseline was
    // recorded: retune them and the baseline must be re-recorded.
    id: "late_round_thread_share",
    label: "Threads raised after the first ladder band",
    side: "pr",
    unit: "share",
    direction: "lower",
    toleranceKind: "absolute",
    tolerance: 0.03,
    baseline: null,
    source: null,
  },
  {
    id: "self_inflicted_share",
    label: "Threads raised on code written after review began",
    side: "pr",
    unit: "share",
    direction: "lower",
    toleranceKind: "absolute",
    tolerance: 0.03,
    baseline: null,
    source: null,
  },
  {
    // Context, not a verdict: the ladder is DESIGNED to lower the late-band
    // accepted share, and a lower share is only good while declined findings
    // do not come back. That second half is `defect-escape.ts`'s to answer;
    // reading this one alone would call a too-strict ladder an improvement.
    id: "accepted_share",
    label: "Accepted share of answered threads",
    side: "pr",
    unit: "share",
    direction: null,
    toleranceKind: "absolute",
    tolerance: 0.03,
    baseline: null,
    source: null,
  },

  // ── Tracker side — the follow-up cohort created in the window ───────────
  {
    id: "mints_per_day",
    label: "Follow-up issues minted per day",
    side: "linear",
    unit: "rate",
    direction: "lower",
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
  {
    id: "cohort_open",
    label: "Open issues in the window’s follow-up cohort",
    side: "linear",
    unit: "count",
    direction: "lower",
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
  {
    id: "cohort_closure_share",
    label: "Cohort closure share (closed / minted)",
    side: "linear",
    unit: "share",
    direction: "higher",
    toleranceKind: "absolute",
    tolerance: 0.03,
    baseline: null,
    source: null,
  },
  {
    id: "priorityless_share",
    label: "Open cohort issues with no priority",
    side: "linear",
    unit: "share",
    direction: "lower",
    toleranceKind: "absolute",
    tolerance: 0.03,
    baseline: null,
    source: null,
  },
  {
    // Context, not a verdict: an epic-closure sweep that moves open debt out
    // of a closing epic RAISES this count by design, so calling a rise "worse"
    // would penalise the mechanism that closes epics.
    id: "parentless_open",
    label: "Open cohort issues with no parent",
    side: "linear",
    unit: "count",
    direction: null,
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
  {
    id: "median_open_age_days",
    label: "Median age of open cohort issues (days)",
    side: "linear",
    unit: "days",
    direction: "lower",
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
  {
    id: "epics_open",
    label: "Open epic issues",
    side: "linear",
    unit: "count",
    direction: null,
    toleranceKind: "relative",
    tolerance: 0.1,
    // Context, not a verdict: an open-epic count is commonly recorded as an
    // approximation, and a tolerance around it would judge a count that may
    // sit inside the baseline's own rounding.
    baseline: null,
    source: null,
  },
  {
    // Context, not a verdict: the snapshot count of epics currently in a
    // completed state (a reopened epic drops out, so it is not a running total)
    // almost never falls, so any completion at all clears the tolerance and
    // reads "improved". The rate below is the figure that can go either way.
    id: "epics_completed",
    label: "Epic issues in a completed state",
    side: "linear",
    unit: "count",
    direction: null,
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
  {
    // The epic close RATE: completions inside the window. It stays
    // `no-baseline` until a person records a first measurement as its
    // baseline; nothing here promotes one automatically.
    id: "epics_completed_in_window",
    label: "Epics completed inside the window",
    side: "linear",
    unit: "count",
    direction: "higher",
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: null,
    source: null,
  },
];

const FLOAT_SLACK = 1e-9;

/**
 * Judge one measured value against its baseline.
 *
 * Order matters and is the fail-honest order: an unmeasured value is never
 * dressed as a verdict (`not-measured` first), a context metric never gets one
 * (`context`), and a metric with no recorded baseline says so rather than
 * comparing against zero (`no-baseline`).
 */
export function verdictOf(spec: MetricSpec, current: number | null): Verdict {
  if (current === null || !Number.isFinite(current)) return "not-measured";
  if (spec.direction === null) return "context";
  if (spec.baseline === null) return "no-baseline";
  const delta = current - spec.baseline;
  const threshold =
    spec.toleranceKind === "relative"
      ? Math.abs(spec.baseline) * spec.tolerance
      : spec.tolerance;
  // The band is inclusive, and `0.53 - 0.5` is 0.03000000000000003 in binary
  // floating point — without a tolerance for that, a value exactly on the edge
  // of a share's band reads as a real move.
  if (Math.abs(delta) <= threshold + FLOAT_SLACK) return "flat";
  const fell = delta < 0;
  return fell === (spec.direction === "lower") ? "improved" : "worse";
}

/** The catalogue with the consumer's recorded baselines applied, by metric id. */
export function withBaselines(
  specs: readonly MetricSpec[],
  baselines: Readonly<Record<string, MetricBaseline>>,
): MetricSpec[] {
  return specs.map((spec) => {
    const b = Object.hasOwn(baselines, spec.id)
      ? baselines[spec.id]
      : undefined;
    return b === undefined
      ? spec
      : { ...spec, baseline: b.value, source: b.source };
  });
}

/** Configured baselines that name a metric this catalogue does not have. */
export function unknownBaselineIds(
  baselines: Readonly<Record<string, MetricBaseline>>,
  specs: readonly MetricSpec[] = METRICS,
): string[] {
  const ids = new Set(specs.map((s) => s.id));
  return Object.keys(baselines).filter((id) => !ids.has(id));
}

/**
 * Baselines whose cited source no longer carries their needle (or cannot be
 * read), relative to the consumer repository `root`. Each problem names the
 * metric, so the scoreboard can say which verdicts rest on a stale number.
 */
export function baselineSourceProblems(
  specs: readonly MetricSpec[],
  root: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string[] {
  const problems: string[] = [];
  const cache = new Map<string, string | null>();
  for (const spec of specs) {
    if (spec.baseline === null || spec.source === null) continue;
    let text = cache.get(spec.source.file);
    if (text === undefined) {
      try {
        text = read(join(root, spec.source.file));
      } catch {
        text = null;
      }
      cache.set(spec.source.file, text);
    }
    if (text === null)
      problems.push(`${spec.id}: ${spec.source.file} could not be read`);
    else if (!text.includes(spec.source.needle))
      problems.push(
        `${spec.id}: ${spec.source.file} no longer contains "${spec.source.needle}"`,
      );
  }
  return problems;
}
