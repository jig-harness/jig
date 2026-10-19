/**
 * Cross-PR aggregation and rendering for the fractal-SDLC scoreboard
 *. Pure over already-fetched samples — no network, no git, no
 * clock — so every rule below is pinnable in a test, the way
 * `lib/metrics.ts` is for one PR. `fractal-metrics.ts` owns the fetching.
 *
 * The decisions here are the ones a reader would otherwise have to
 * rediscover:
 *
 * ── A "round" is the ordinal of the bot-reviewed head a thread was raised on
 *
 * The drive's own round counter is per-clone durable state, so it cannot be
 * recovered for a PR driven elsewhere or archived since (`loop-metrics.ts`
 * says the same about `rounds.durable`). What every PR does carry is its
 * initiating bot reviews. A thread's `reviewedHeadOid` is the head it was
 * raised against; that head's position among the PR's distinct initiating bot
 * heads — the identical population `rounds.reviewedHeads` counts, via
 * `initiatingBotReviews` — is its round. It is a proxy for the ladder's
 * round, not the same counter: a driver that pushes twice between reviews
 * advances the drive's counter but not this one. A thread whose head is not
 * among the PR's reviewed heads (history rewritten after the review) has
 * NO round and lands in `unknown-round`, reported rather than guessed.
 *
 * ── Bands come from the ladder's own config
 *
 * "Round band" means `.config/review-triage.yaml` § `bands`, passed in, so
 * retuning the ladder retunes what this scoreboard cuts by and the two never
 * describe different round ranges.
 *
 * ── Every share carries its denominator, and "not measured" is not zero
 *
 * A share over an empty population is `null`, never `0`. A self-inflicted
 * ratio measured on a fraction of the threads is reported with that
 * fraction, since a ratio over the threads that happened to be blameable is
 * not a ratio over the PR.
 */

import {
  METRICS,
  type MetricSpec,
  type Verdict,
  verdictOf,
} from "./fractal-baseline.ts";
import { initiatingBotReviews } from "./metrics.ts";
import type { Outcome } from "./outcome.ts";
import type { PrSample } from "./sample.ts";

const DAY_MS = 86_400_000;

/** Threads whose head is not among the PR's reviewed heads. */
export const UNKNOWN_ROUND = "unknown-round";
/** A known round that no configured band contains (a gap in the config). */
export const OUTSIDE_BANDS = "outside-bands";
export const UNKNOWN_SEVERITY = "unknown";

/** The subset of the ladder's `Band` this module reads. */
export interface BandLike {
  id: string;
  fromRound: number;
  /** `null` is open-ended. */
  throughRound: number | null;
}

export function bandIdOf(
  bands: ReadonlyArray<BandLike>,
  round: number | null,
): string {
  if (round === null) return UNKNOWN_ROUND;
  for (const b of bands) {
    if (round < b.fromRound) continue;
    if (b.throughRound === null || round <= b.throughRound) return b.id;
  }
  return OUTSIDE_BANDS;
}

// ── Statistics ──────────────────────────────────────────────────────────────

export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Nearest-rank percentile: the smallest value with at least `p` of the sample
 * at or below it. Nearest-rank (not interpolated) because the inputs are
 * whole counts of reviewed heads, and an interpolated "p90 of 13.4 heads"
 * names a PR that never existed.
 */
export function percentile(
  values: ReadonlyArray<number>,
  p: number,
): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * s.length));
  return s[Math.min(rank, s.length) - 1] as number;
}

function share(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Days of the Monday-start week `week` (`YYYY-MM-DD`) inside the window; 7 when there is none. */
function daysInWindow(
  week: string,
  window: { sinceMs: number; untilMs: number } | null,
): number {
  if (window === null) return 7;
  const start = Date.parse(`${week}T00:00:00Z`);
  const overlap =
    Math.min(start + 7 * DAY_MS, window.untilMs) -
    Math.max(start, window.sinceMs);
  return Math.max(0, Math.round(overlap / DAY_MS));
}

/** Monday 00:00 UTC of the week containing `iso`, as `YYYY-MM-DD`. */
export function weekStartOf(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(ms - sinceMonday * DAY_MS - (ms % DAY_MS))
    .toISOString()
    .slice(0, 10);
}

// ── PR side ─────────────────────────────────────────────────────────────────

export interface ThreadRow {
  round: number | null;
  band: string;
  severity: string;
  outcome: Outcome | null;
  /** `null` = not measured (head unfetchable, no anchor, LEFT side, …). */
  selfInflicted: boolean | null;
}

export interface PrRecord {
  pr: number;
  mergedAt: string | null;
  /** Distinct heads a bot reviewed — `LoopMetrics.rounds.reviewedHeads`. */
  reviewedHeads: number;
  threads: ThreadRow[];
}

/** Head oid → 1-based round, in the order the bots first reviewed each head. */
export function roundIndexByHead(sample: PrSample): Map<string, number> {
  const heads = new Map<string, number>();
  for (const r of initiatingBotReviews(sample.reviews)) {
    if (!heads.has(r.oid)) heads.set(r.oid, heads.size + 1);
  }
  return heads;
}

export function buildPrRecord(
  sample: PrSample,
  bands: ReadonlyArray<BandLike>,
  selfInflicted: ReadonlyMap<string, boolean | null>,
): PrRecord {
  const heads = roundIndexByHead(sample);
  return {
    pr: sample.pr,
    mergedAt: sample.mergedAt,
    reviewedHeads: heads.size,
    threads: sample.threads.map((t) => {
      const round =
        t.reviewedHeadOid === null
          ? null
          : (heads.get(t.reviewedHeadOid) ?? null);
      return {
        round,
        band: bandIdOf(bands, round),
        severity: t.severity,
        outcome: t.outcome,
        selfInflicted: selfInflicted.get(t.threadId) ?? null,
      };
    }),
  };
}

export interface Cell {
  accepted: number;
  answered: number;
  /** `null` when nothing was answered — not measured, never 0%. */
  share: number | null;
}

export interface SelfInflictedCell {
  measured: number;
  selfInflicted: number;
  share: number | null;
}

/** Eligible threads of a cut, measured or not, and the share that was measured. */
export interface CoverageCell {
  eligible: number;
  coverage: number | null;
}

export interface PrSide {
  prs: number;
  /** PRs with at least one bot-reviewed head — the rounds population. */
  prsWithRounds: number;
  rounds: {
    median: number | null;
    p90: number | null;
    max: number | null;
  };
  threads: {
    total: number;
    answered: number;
    /** Threads with no recoverable round; excluded from every band cut. */
    unknownRound: number;
  };
  accepted: Cell;
  byBand: Record<string, Cell>;
  bySeverity: Record<string, Cell>;
  byBandSeverity: Record<string, Record<string, Cell>>;
  lateRoundThreadShare: {
    late: number;
    /** Threads with a known round. */
    total: number;
    /** `total` over every thread — the baseline's denominator. */
    coverage: number | null;
    share: number | null;
  };
  selfInflicted: {
    /**
     * Threads that COULD be raised on post-review code (temporal, not causal): raised on a head after the first
     * bot-reviewed one (round >= 2, known). A round-1 thread predates every
     * fix, so it is excluded from the population rather than counted `false`.
     */
    eligible: number;
    measured: number;
    selfInflicted: number;
    share: number | null;
    /** `measured / eligible`. A low value means the share is a subset. */
    coverage: number | null;
    byBand: Record<string, SelfInflictedCell & CoverageCell>;
    /** Per Monday-start week of the PR's merge — the within-window trend. */
    /**
     * `days` is how many days of that Monday-start week fall inside the PR
     * window: a 7-day window that is not Monday-aligned yields two partial
     * buckets, and an unlabelled 1-day bucket reads as a full week.
     */
    byWeek: Array<
      SelfInflictedCell & {
        week: string;
        days: number;
        /** Eligible threads of the week, measured or not. */
        eligible: number;
        /** `measured / eligible`; a week with none measured reads 0, not absent. */
        coverage: number | null;
      }
    >;
  };
}

function cell(accepted: number, answered: number): Cell {
  return { accepted, answered, share: share(accepted, answered) };
}

/** Tallies of `(accepted, answered)` keyed by an arbitrary string. */
class CellMap {
  private readonly m = new Map<string, [number, number]>();
  add(key: string, accepted: boolean): void {
    const c = this.m.get(key) ?? [0, 0];
    c[1] += 1;
    if (accepted) c[0] += 1;
    this.m.set(key, c);
  }
  entries(order: ReadonlyArray<string>): Array<[string, Cell]> {
    const keys = [
      ...order.filter((k) => this.m.has(k)),
      ...[...this.m.keys()].filter((k) => !order.includes(k)).sort(),
    ];
    return keys.map((k) => {
      const [a, n] = this.m.get(k) as [number, number];
      return [k, cell(a, n)];
    });
  }
}

export function aggregatePrSide(
  records: ReadonlyArray<PrRecord>,
  bands: ReadonlyArray<BandLike>,
  severityOrder: ReadonlyArray<string>,
  /** The PR window, so a week bucket can report how much of it is in range. */
  window: { sinceMs: number; untilMs: number } | null = null,
): PrSide {
  const bandOrder = bands.map((b) => b.id);
  const severities = [...severityOrder, UNKNOWN_SEVERITY];
  const heads = records
    .filter((r) => r.reviewedHeads > 0)
    .map((r) => r.reviewedHeads);

  const overall = new CellMap();
  const byBand = new CellMap();
  const bySeverity = new CellMap();
  const byBandSeverity = new Map<string, CellMap>();
  let total = 0;
  let answered = 0;
  let unknownRound = 0;
  let knownRound = 0;
  let late = 0;
  const firstBand = bands[0]?.id ?? null;

  // Per band: [measured, self-inflicted, eligible]; eligible counts unblamed threads too.
  const siByBand = new Map<string, [number, number, number]>();
  // Per week: [measured, self-inflicted, eligible]. Eligible is counted whether
  // or not the thread could be blamed, so a week nothing was measured in still
  // appears — with coverage 0 — rather than vanishing from the trend.
  const siByWeek = new Map<string, [number, number, number]>();
  let siEligible = 0;
  let siMeasured = 0;
  let siTrue = 0;

  for (const r of records) {
    const week = r.mergedAt === null ? null : weekStartOf(r.mergedAt);
    for (const t of r.threads) {
      total += 1;
      if (t.round === null) unknownRound += 1;
      else {
        knownRound += 1;
        if (firstBand !== null && t.band !== firstBand) late += 1;
      }
      if (t.outcome !== null) {
        answered += 1;
        const acc = t.outcome === "accepted";
        overall.add("all", acc);
        byBand.add(t.band, acc);
        bySeverity.add(t.severity, acc);
        const row = byBandSeverity.get(t.band) ?? new CellMap();
        row.add(t.severity, acc);
        byBandSeverity.set(t.band, row);
      }
      const eligibleForSi = t.round !== null && t.round >= 2;
      if (eligibleForSi) {
        siEligible += 1;
        const bEl = siByBand.get(t.band) ?? [0, 0, 0];
        bEl[2] += 1;
        siByBand.set(t.band, bEl);
        if (week !== null) {
          const w = siByWeek.get(week) ?? [0, 0, 0];
          w[2] += 1;
          siByWeek.set(week, w);
        }
      }
      if (eligibleForSi && t.selfInflicted !== null) {
        siMeasured += 1;
        if (t.selfInflicted) siTrue += 1;
        const b = siByBand.get(t.band) as [number, number, number];
        b[0] += 1;
        if (t.selfInflicted) b[1] += 1;
        if (week !== null) {
          const w = siByWeek.get(week) as [number, number, number];
          w[0] += 1;
          if (t.selfInflicted) w[1] += 1;
        }
      }
    }
  }

  const bandKeys = [...bandOrder, OUTSIDE_BANDS, UNKNOWN_ROUND];
  const siCell = ([m, s]: [number, number]): SelfInflictedCell => ({
    measured: m,
    selfInflicted: s,
    share: share(s, m),
  });
  const orderedSi = (
    map: Map<string, [number, number, number]>,
    order: ReadonlyArray<string>,
  ): Array<[string, SelfInflictedCell & CoverageCell]> =>
    [
      ...order.filter((k) => map.has(k)),
      ...[...map.keys()].filter((k) => !order.includes(k)).sort(),
    ].map((k) => {
      const [m, sTrue, e] = map.get(k) as [number, number, number];
      return [k, { ...siCell([m, sTrue]), eligible: e, coverage: share(m, e) }];
    });

  const accepted = overall.entries(["all"])[0]?.[1] ?? cell(0, 0);
  return {
    prs: records.length,
    prsWithRounds: heads.length,
    rounds: {
      median: median(heads),
      p90: percentile(heads, 0.9),
      max: heads.length === 0 ? null : Math.max(...heads),
    },
    threads: { total, answered, unknownRound },
    accepted,
    byBand: Object.fromEntries(byBand.entries(bandKeys)),
    bySeverity: Object.fromEntries(bySeverity.entries(severities)),
    byBandSeverity: Object.fromEntries(
      [...byBandSeverity.entries()]
        .sort(([a], [b]) => bandKeys.indexOf(a) - bandKeys.indexOf(b))
        .map(([band, row]) => [
          band,
          Object.fromEntries(row.entries(severities)),
        ]),
    ),
    lateRoundThreadShare: {
      late,
      total: knownRound,
      coverage: share(knownRound, total),
      share: firstBand === null ? null : share(late, knownRound),
    },
    selfInflicted: {
      eligible: siEligible,
      measured: siMeasured,
      selfInflicted: siTrue,
      share: share(siTrue, siMeasured),
      coverage: share(siMeasured, siEligible),
      byBand: Object.fromEntries(orderedSi(siByBand, bandKeys)),
      byWeek: [...siByWeek.keys()].sort().map((week) => {
        const [m, sTrue, e] = siByWeek.get(week) as [number, number, number];
        return {
          week,
          ...siCell([m, sTrue]),
          days: daysInWindow(week, window),
          eligible: e,
          coverage: share(m, e),
        };
      }),
    },
  };
}

// ── Linear side ─────────────────────────────────────────────────────────────

/** The fields of a ledger issue the baseline cohort is defined over. */
export interface CohortIssue {
  createdAt: string;
  stateType: string;
  /** Linear 0-4; 0 = none. */
  priority: number;
  parent: string | null;
  labels: string[];
  /**
   * Fields the ledger reader could not read in full (`LedgerIssue.truncated`).
   * Absent means nothing was reported truncated.
   */
  truncated?: ReadonlyArray<string>;
}

export interface CohortWindow {
  label: string;
  sinceMs: number;
  untilMs: number;
  nowMs: number;
  closedStateTypes: ReadonlyArray<string>;
}

export interface CohortStats {
  label: string;
  since: string;
  until: string;
  days: number;
  minted: number;
  open: number;
  closed: number;
  closureShare: number | null;
  mintsPerDay: number;
  priorityless: number;
  prioritylessShare: number | null;
  parentless: number;
  medianOpenAgeDays: number | null;
}

/**
 * The cohort definition, applied to a window:
 * issues carrying `label` created in `[since, until)`; open is `stateType`
 * outside the closed set; priorityless and parentless and median age are over
 * that open population.
 *
 * Throws on an unparseable `createdAt` rather than skipping the issue: a
 * silently shortened cohort reads as fewer mints, which is the flattering
 * direction.
 */
export function cohortStats(
  issues: ReadonlyArray<CohortIssue>,
  w: CohortWindow,
): CohortStats {
  // The ledger reader keeps only the first page of an issue's labels. An issue
  // whose label list was cut and does not show `w.label` may carry it on a
  // later page, and dropping it would shorten the cohort — the flattering
  // direction — so the cohort is refused rather than measured over a guess.
  // Only issues that could fall in the window matter: an older one cannot
  // change the cohort whichever labels it carries. An unparseable `createdAt`
  // stays in, so the cohort loop below still throws on it.
  const unreadable = issues.filter((i) => {
    if (!i.truncated?.includes("labels") || i.labels.includes(w.label)) {
      return false;
    }
    const created = Date.parse(i.createdAt);
    return (
      Number.isNaN(created) || (created >= w.sinceMs && created < w.untilMs)
    );
  });
  if (unreadable.length > 0) {
    throw new Error(
      `cohort: ${unreadable.length} ledger issue(s) have a truncated label list and none of the labels read is '${w.label}', so cohort membership cannot be established`,
    );
  }
  const cohort = issues.filter((i) => {
    if (!i.labels.includes(w.label)) return false;
    const created = Date.parse(i.createdAt);
    if (Number.isNaN(created)) {
      throw new Error(
        `cohort: unparseable createdAt ${JSON.stringify(i.createdAt)}`,
      );
    }
    return created >= w.sinceMs && created < w.untilMs;
  });
  const open = cohort.filter((i) => !w.closedStateTypes.includes(i.stateType));
  const priorityless = open.filter((i) => i.priority === 0).length;
  const days = (w.untilMs - w.sinceMs) / DAY_MS;
  return {
    label: w.label,
    since: new Date(w.sinceMs).toISOString(),
    until: new Date(w.untilMs).toISOString(),
    days,
    minted: cohort.length,
    open: open.length,
    closed: cohort.length - open.length,
    closureShare: share(cohort.length - open.length, cohort.length),
    mintsPerDay: days === 0 ? 0 : cohort.length / days,
    priorityless,
    prioritylessShare: share(priorityless, open.length),
    parentless: open.filter((i) => i.parent === null).length,
    medianOpenAgeDays: median(
      open.map((i) => Math.floor((w.nowMs - Date.parse(i.createdAt)) / DAY_MS)),
    ),
  };
}

export interface EpicIssue {
  stateType: string;
  completedAt: string | null;
}

export interface EpicStats {
  total: number;
  open: number;
  /** `statusType: started` — the "60+ simultaneously started" figure. */
  started: number;
  completed: number;
  /** Completed with a `completedAt` inside `[since, until)`. */
  completedInWindow: number;
}

export function epicStats(
  issues: ReadonlyArray<EpicIssue>,
  closedStateTypes: ReadonlyArray<string>,
  sinceMs: number,
  untilMs: number,
): EpicStats {
  let open = 0;
  let started = 0;
  let completed = 0;
  let completedInWindow = 0;
  for (const i of issues) {
    if (!closedStateTypes.includes(i.stateType)) open += 1;
    if (i.stateType === "started") started += 1;
    if (i.stateType === "completed") {
      completed += 1;
      const at =
        i.completedAt === null ? Number.NaN : Date.parse(i.completedAt);
      if (at >= sinceMs && at < untilMs) completedInWindow += 1;
    }
  }
  return { total: issues.length, open, started, completed, completedInWindow };
}

/** The debt-ledger figures this scoreboard prints as context. */
export interface LedgerContext {
  total: number;
  open: number;
  closed: number;
  windowDays: number;
  minted: number;
  closedInWindow: number;
  mintedPerDay: number;
  closedPerDay: number;
  mintToCloseRatio: number | null;
  medianOpenAgeDays: number | null;
  oldestOpenAgeDays: number | null;
  priorityless: number;
  prioritylessShare: number;
  /** Non-empty means every ledger count is a floor. */
  truncated: string[];
}

export interface LinearSide {
  cohort: CohortStats;
  epics: EpicStats;
  ledger: LedgerContext;
}

// ── Scoreboard ──────────────────────────────────────────────────────────────

export interface MetricRow {
  id: string;
  label: string;
  side: "pr" | "linear";
  unit: MetricSpec["unit"];
  baseline: number | null;
  current: number | null;
  /**
   * `current` is the measured-subset share of an interval-judged metric: the
   * all-thread figure the baseline divides by lies somewhere in an interval,
   * so `current` is not comparable point-for-point and no delta is reported.
   */
  bounded: boolean;
  delta: number | null;
  verdict: Verdict;
}

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

/**
 * Ids whose published `current` is a measured-subset share (judged, but with
 * unmeasured threads that the baseline's denominator includes).
 */
export function boundedMetricIds(
  pr: PrSide | null,
  specs: ReadonlyArray<MetricSpec> = METRICS,
): Set<string> {
  const ids = new Set<string>();
  if (pr === null) return ids;
  if (pr.threads.unknownRound > 0 && judgedLateRoundShare(pr, specs) !== null) {
    ids.add("late_round_thread_share");
  }
  if (
    pr.selfInflicted.eligible > pr.selfInflicted.measured &&
    judgedSelfInflictedShare(pr, specs) !== null
  ) {
    ids.add("self_inflicted_share");
  }
  return ids;
}

/** Current values for every spec id this run measured; absent = not measured. */
export function currentValues(
  pr: PrSide | null,
  linear: LinearSide | null,
  specs: ReadonlyArray<MetricSpec> = METRICS,
): Record<string, number | null> {
  const v: Record<string, number | null> = {};
  if (pr !== null) {
    v.rounds_median = pr.rounds.median;
    v.rounds_p90 = pr.rounds.p90;
    v.late_round_thread_share = judgedLateRoundShare(pr, specs);
    v.self_inflicted_share = judgedSelfInflictedShare(pr, specs);
    v.accepted_share = pr.accepted.share;
  }
  if (linear !== null) {
    v.mints_per_day = linear.cohort.mintsPerDay;
    v.cohort_open = linear.cohort.open;
    v.cohort_closure_share = linear.cohort.closureShare;
    v.priorityless_share = linear.cohort.prioritylessShare;
    v.parentless_open = linear.cohort.parentless;
    v.median_open_age_days = linear.cohort.medianOpenAgeDays;
    v.epics_open = linear.epics.open;
    v.epics_completed = linear.epics.completed;
    v.epics_completed_in_window = linear.epics.completedInWindow;
  }
  return v;
}

/**
 * One row per spec of every side that was requested. A requested side whose
 * value is missing is `not-measured` — a metric that could not be produced is
 * never silently dropped from the table, which would read as "no regression".
 */
export function metricRows(
  sides: ReadonlySet<"pr" | "linear">,
  values: Readonly<Record<string, number | null>>,
  specs: ReadonlyArray<MetricSpec> = METRICS,
  bounded: ReadonlySet<string> = new Set(),
): MetricRow[] {
  return specs
    .filter((s) => sides.has(s.side))
    .map((s) => {
      const current = values[s.id] ?? null;
      // Approximate only what is published: a withheld row has no measured subset.
      const isBounded = current !== null && bounded.has(s.id);
      return {
        id: s.id,
        label: s.label,
        side: s.side,
        unit: s.unit,
        baseline: s.baseline,
        current,
        bounded: isBounded,
        delta:
          current !== null && s.baseline !== null && !isBounded
            ? current - s.baseline
            : null,
        verdict: verdictOf(s, current),
      };
    });
}

export interface Scoreboard {
  version: 1;
  generatedAt: string;
  /**
   * Both windows are half-open `[since, until)` in UTC and share one end. They
   * differ in length because the two sides are measured against different
   * things: the PR side against a one-week baseline, the Linear cohort against
   * the baseline's rolling 37 days.
   */
  window: {
    until: string;
    pr: { since: string; days: number };
    linear: { since: string; days: number };
  };
  pr: PrSide | null;
  linear: LinearSide | null;
  metrics: MetricRow[];
  /** Convergence-speed figures ship with the defect-escape anchor. */
  escapeAnchor: string;
  caveats: string[];
}

// ── Rendering ───────────────────────────────────────────────────────────────

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

export function formatValue(
  unit: MetricSpec["unit"],
  v: number | null,
): string {
  if (v === null) return "n/a";
  if (unit === "share") return pct(v);
  if (unit === "rate") return v.toFixed(1);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function formatDelta(unit: MetricSpec["unit"], d: number | null): string {
  if (d === null) return "—";
  const sign = d > 0 ? "+" : "";
  return unit === "share"
    ? `${sign}${(d * 100).toFixed(1)} pp`
    : `${sign}${Number.isInteger(d) ? d : d.toFixed(1)}`;
}

function cellText(c: Cell | undefined): string {
  if (c === undefined || c.answered === 0) return "—";
  return `${pct(c.share)} (${c.accepted}/${c.answered})`;
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

export function renderScoreboard(sb: Scoreboard): string {
  // The baselines the verdicts were judged against travel in the rows.
  const specs = METRICS.map((m) => {
    const row = sb.metrics.find((r) => r.id === m.id);
    return row === undefined ? m : { ...m, baseline: row.baseline };
  });
  const out: string[] = [
    "# Fractal SDLC scoreboard",
    "",
    `Generated ${sb.generatedAt} · windows end ${sb.window.until} (exclusive)`,
    "",
    `- PR side: \`[${sb.window.pr.since}, …)\` — ${sb.window.pr.days} days`,
    `- Linear cohort: \`[${sb.window.linear.since}, …)\` — ${sb.window.linear.days} days`,
    "",
    "## Verdicts vs the recorded baseline",
    "",
    table(
      ["Metric", "Baseline", "Now", "Δ", "Verdict"],
      sb.metrics.map((m) => [
        m.label,
        formatValue(m.unit, m.baseline),
        `${m.bounded ? "≈" : ""}${formatValue(m.unit, m.current)}`,
        formatDelta(m.unit, m.delta),
        `**${m.verdict}**`,
      ]),
    ),
  ];

  const pr = sb.pr;
  if (pr !== null) {
    out.push(
      "",
      "## PR side",
      "",
      `${pr.prs} merged PRs (${pr.prsWithRounds} with at least one bot-reviewed head) · ` +
        `${pr.threads.total} threads, ${pr.threads.answered} answered, ${pr.threads.unknownRound} with no recoverable round.`,
      "",
      `Bot-reviewed heads per PR: median ${pr.rounds.median ?? "n/a"} · p90 ${pr.rounds.p90 ?? "n/a"} · max ${pr.rounds.max ?? "n/a"}.`,
      "",
      "### Accepted share by round band and severity",
      "",
    );
    const sevs = Object.keys(pr.bySeverity);
    out.push(
      table(
        ["Band", ...sevs, "All"],
        [
          ...Object.entries(pr.byBandSeverity).map(([band, row]) => [
            band,
            ...sevs.map((s) => cellText(row[s])),
            cellText(pr.byBand[band]),
          ]),
          [
            "**all bands**",
            ...sevs.map((s) => cellText(pr.bySeverity[s])),
            cellText(pr.accepted),
          ],
        ],
      ),
      "",
      `Threads raised after the first band: ${judgedLateRoundShare(pr, specs) === null ? `${pr.lateRoundThreadShare.late}/${pr.lateRoundThreadShare.total} with a known round (share withheld: the ${pr.threads.unknownRound} threads with no recoverable round could move the verdict either way)` : `${pct(pr.lateRoundThreadShare.share)} of threads with a known round (${pr.lateRoundThreadShare.late}/${pr.lateRoundThreadShare.total}${pr.threads.unknownRound > 0 ? `; against all ${pr.lateRoundThreadShare.total + pr.threads.unknownRound} threads it lies between ${pct(pr.lateRoundThreadShare.late / (pr.lateRoundThreadShare.total + pr.threads.unknownRound))} and ${pct((pr.lateRoundThreadShare.late + pr.threads.unknownRound) / (pr.lateRoundThreadShare.total + pr.threads.unknownRound))}` : ""})`}.`,
      "",
      "### Self-inflicted",
      "",
      `${judgedSelfInflictedShare(pr, specs) === null ? `${pr.selfInflicted.selfInflicted} of ${pr.selfInflicted.measured} measured threads (share withheld: coverage is ${pr.selfInflicted.eligible === 0 ? "absent" : `below the ${MIN_SELF_INFLICTED_COVERAGE * 100}% floor or the unmeasured threads could move the verdict`})` : `${pct(pr.selfInflicted.share)} of ${pr.selfInflicted.measured} measured threads`} were raised on code written after review began ` +
        `(coverage ${pct(pr.selfInflicted.coverage)} of the ${pr.selfInflicted.eligible} threads raised after the first reviewed head; the rest could not be blamed).`,
    );
    if (pr.selfInflicted.measured > 0) {
      out.push(
        "",
        table(
          ["Cut", "Measured", "Self-inflicted", "Share"],
          [
            ...Object.entries(pr.selfInflicted.byBand).map(([k, c]) => [
              `band \`${k}\` (${c.measured}/${c.eligible} eligible measured, ${pct(c.coverage)})`,
              String(c.measured),
              String(c.selfInflicted),
              c.measured === 0
                ? "not measured"
                : cutShareIsPublishable(pr, c, specs)
                  ? pct(c.share)
                  : "withheld",
            ]),
            ...pr.selfInflicted.byWeek.map((c) => [
              `week of ${c.week} (${c.days} day${c.days === 1 ? "" : "s"} in window; ${c.measured}/${c.eligible} eligible measured, ${pct(c.coverage)})`,
              String(c.measured),
              String(c.selfInflicted),
              c.measured === 0
                ? "not measured"
                : cutShareIsPublishable(pr, c, specs)
                  ? pct(c.share)
                  : "withheld",
            ]),
          ],
        ),
      );
    }
  }

  const lin = sb.linear;
  if (lin !== null) {
    const c = lin.cohort;
    out.push(
      "",
      `## Linear side — \`${c.label}\` cohort minted in the window`,
      "",
      table(
        ["Quantity", "Value"],
        [
          [
            "Minted",
            `${c.minted} (${c.mintsPerDay.toFixed(1)}/day over ${c.days} days)`,
          ],
          [
            "Open / closed",
            `${c.open} / ${c.closed} (closure share ${pct(c.closureShare)})`,
          ],
          [
            "Open with no priority",
            `${c.priorityless} (${pct(c.prioritylessShare)})`,
          ],
          ["Open with no parent", String(c.parentless)],
          [
            "Median open age",
            c.medianOpenAgeDays === null
              ? "n/a"
              : `${c.medianOpenAgeDays} days`,
          ],
        ],
      ),
      "",
      `Epics: ${lin.epics.open} open (${lin.epics.started} started), ${lin.epics.completed} completed, ${lin.epics.completedInWindow} completed inside the window, ${lin.epics.total} in total.`,
      "",
      "### Debt ledger (the follow-up label ∪ the configured debt project)",
      "",
      "Context, not verdict-bearing: its population is the union, the baseline’s is the label cohort above.",
      "",
      table(
        ["Quantity", "Value"],
        [
          [
            "Ledger",
            `${lin.ledger.total} issues — ${lin.ledger.open} open, ${lin.ledger.closed} closed`,
          ],
          [
            `Flow, trailing ${lin.ledger.windowDays} days`,
            `${lin.ledger.minted} minted (${lin.ledger.mintedPerDay}/day) vs ${lin.ledger.closedInWindow} closed (${lin.ledger.closedPerDay}/day); ratio ${lin.ledger.mintToCloseRatio ?? "n/a"}`,
          ],
          [
            "Open age",
            `median ${lin.ledger.medianOpenAgeDays ?? "n/a"} days, oldest ${lin.ledger.oldestOpenAgeDays ?? "n/a"}`,
          ],
          [
            "Open with no priority",
            `${lin.ledger.priorityless} (${pct(lin.ledger.prioritylessShare)})`,
          ],
        ],
      ),
    );
    if (lin.ledger.truncated.length > 0) {
      out.push(
        "",
        `**Truncated:** ${lin.ledger.truncated.join(", ")} — every ledger count above is a floor.`,
      );
    }
  }

  out.push("", sb.escapeAnchor);
  if (sb.caveats.length > 0) {
    out.push("", "## Caveats", "", ...sb.caveats.map((c) => `- ${c}`));
  }
  return `${out.join("\n")}\n`;
}
