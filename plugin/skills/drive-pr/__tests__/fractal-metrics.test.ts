/**
 * fractal-metrics.test.ts — the cross-PR scoreboard.
 *
 * Pinned, in order of how badly a silent regression would mislead:
 *
 *  - the VERDICT rule, because a scoreboard that calls a flat month "improved"
 *    (or an unmeasured one "flat") is worse than none;
 *  - the BASELINE application: the consumer's recorded numbers reach the
 *    verdicts, and a citation that no longer holds is detected;
 *  - the ROUND rule (a thread's round is the ordinal of the bot-reviewed head it
 *    was raised on, from the same population `reviewedHeads` counts) and the
 *    "not measured is not zero" discipline of every share;
 *  - the composition `main` runs, against injected deps, so the window
 *    arithmetic and the partial-result exit path are exercised for real;
 *  - the retroactive self-inflicted labeller against a real throwaway
 *    repository — a suite that only injected a predicate would never exercise
 *    the git-backed path (the same gap `defect-escape.test.ts` closes for
 *    `defect-escape.ts`).
 *
 * No network: everything above the labeller is pure over fixtures.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeSelfInflictedLabeler,
  parseArgs,
  type RunDeps,
  runScoreboard,
} from "../scripts/fractal-metrics.ts";
import {
  aggregatePrSide,
  bandIdOf,
  boundedMetricIds,
  buildPrRecord,
  cohortStats,
  currentValues,
  cutShareIsPublishable,
  epicStats,
  judgedSelfInflictedShare,
  type LinearSide,
  median,
  metricRows,
  OUTSIDE_BANDS,
  type PrRecord,
  percentile,
  renderScoreboard,
  roundIndexByHead,
  UNKNOWN_ROUND,
  weekStartOf,
} from "../scripts/lib/fractal.ts";
import type { MetricBaseline } from "../scripts/lib/fleet-health-config.ts";
import {
  baselineSourceProblems,
  METRICS,
  type MetricSpec,
  unknownBaselineIds,
  verdictOf,
  withBaselines,
} from "../scripts/lib/fractal-baseline.ts";
import { ledgerContextOf } from "../scripts/lib/fractal-linear.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";
import type {
  PrSample,
  ReviewSample,
  ThreadSample,
} from "../scripts/lib/sample.ts";

/** A consumer's recorded baselines, with the citation each states. */
const PINNED: Record<string, { value: number; cites: string }> = {
  merge_conflict_share: { value: 0, cites: "| conflict share | 0 |" },
  rounds_median: { value: 10, cites: "| median heads | 10 |" },
  rounds_p90: { value: 25, cites: "| p90 heads | 25 |" },
  late_round_thread_share: { value: 1226 / 1756, cites: "1226/1756" },
  self_inflicted_share: { value: 988 / 1543, cites: "988/1543" },
  accepted_share: { value: 1334 / 1646, cites: "1334/1646" },
  mints_per_day: { value: 485 / 37, cites: "485 in 37 days" },
  cohort_open: { value: 297, cites: "| still open | 297 |" },
  cohort_closure_share: { value: 188 / 485, cites: "188/485" },
  priorityless_share: { value: 0.63, cites: "| no priority | 63% |" },
  parentless_open: { value: 124, cites: "| no parent | 124 |" },
  median_open_age_days: { value: 16, cites: "| median age | 16 days |" },
  epics_open: { value: 111, cites: "| open epics | ~111 |" },
  epics_completed: { value: 8, cites: "| completed epics | 8 |" },
};
const BASELINES: Record<string, MetricBaseline> = Object.fromEntries(
  Object.entries(PINNED).map(([id, p]) => [
    id,
    { value: p.value, source: { file: "baselines.md", needle: p.cites } },
  ]),
);
/** The catalogue as a consumer with every baseline recorded sees it. */
const SPECS = withBaselines(METRICS, BASELINES);
const BANDS = [
  { id: "boy-scout", fromRound: 1, throughRound: 3 },
  { id: "escalated", fromRound: 4, throughRound: 6 },
  { id: "late", fromRound: 7, throughRound: null },
];
const SEVERITIES = ["low", "medium", "high", "blocker"];

// ── Fixtures ────────────────────────────────────────────────────────────────

function review(
  oid: string,
  at: string,
  over: Partial<ReviewSample> = {},
): ReviewSample {
  return {
    oid,
    submittedAt: at,
    author: "bot-app",
    isBot: true,
    initiating: true,
    ...over,
  };
}

function thread(over: Partial<ThreadSample> = {}): ThreadSample {
  return {
    threadId: "t",
    path: "a.ts",
    line: 10,
    originalLine: 10,
    diffSide: "RIGHT",
    isOutdated: false,
    isResolved: true,
    startedBy: "bot-app",
    startedByBot: true,
    url: null,
    outcome: "accepted",
    reason: "fixed",
    settledBody: "fixed",
    createdAt: "2026-09-01T00:00:00Z",
    settledAt: "2026-09-01T01:00:00Z",
    commentsTruncated: false,
    category: "unknown",
    severity: "medium",
    reviewedHeadOid: null,
    ...over,
  };
}

function sample(over: Partial<PrSample> = {}): PrSample {
  return {
    pr: 1,
    state: "MERGED",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    baseRefName: "develop",
    headRefOid: "h",
    createdAt: "2026-09-01T00:00:00Z",
    mergedAt: "2026-09-02T00:00:00Z",
    mergeCommitOid: "",
    title: "t",
    commits: [],
    reviews: [],
    threads: [],
    ...over,
  };
}

function record(over: Partial<PrRecord> & Pick<PrRecord, "threads">): PrRecord {
  return { pr: 1, mergedAt: "2026-09-02T00:00:00Z", reviewedHeads: 1, ...over };
}

const row = (
  round: number | null,
  outcome: PrRecord["threads"][number]["outcome"],
  severity = "medium",
  selfInflicted: boolean | null = null,
): PrRecord["threads"][number] => ({
  round,
  band: bandIdOf(BANDS, round),
  severity,
  outcome,
  selfInflicted,
});

// ── Verdicts ────────────────────────────────────────────────────────────────

function spec(over: Partial<MetricSpec> = {}): MetricSpec {
  return {
    id: "x",
    label: "x",
    side: "pr",
    unit: "count",
    direction: "lower",
    toleranceKind: "relative",
    tolerance: 0.1,
    baseline: 100,
    source: null,
    ...over,
  };
}

describe("verdictOf", () => {
  it("lower-is-better: a real drop improves, a real rise is worse", () => {
    expect(verdictOf(spec(), 50)).toBe("improved");
    expect(verdictOf(spec(), 150)).toBe("worse");
  });

  it("higher-is-better reverses the reading", () => {
    expect(verdictOf(spec({ direction: "higher" }), 150)).toBe("improved");
    expect(verdictOf(spec({ direction: "higher" }), 50)).toBe("worse");
  });

  it("is flat INCLUSIVELY at the relative tolerance, and not beyond it", () => {
    expect(verdictOf(spec(), 90)).toBe("flat");
    expect(verdictOf(spec(), 110)).toBe("flat");
    expect(verdictOf(spec(), 89)).toBe("improved");
    expect(verdictOf(spec(), 111)).toBe("worse");
  });

  it("applies an absolute tolerance in fractional points, not as a ratio", () => {
    const s = spec({
      toleranceKind: "absolute",
      tolerance: 0.03,
      baseline: 0.5,
      unit: "share",
    });
    expect(verdictOf(s, 0.53)).toBe("flat");
    expect(verdictOf(s, 0.54)).toBe("worse");
    expect(verdictOf(s, 0.46)).toBe("improved");
  });

  it("never dresses an unmeasured value as a verdict", () => {
    expect(verdictOf(spec(), null)).toBe("not-measured");
    expect(verdictOf(spec(), Number.NaN)).toBe("not-measured");
    // Even a context metric: "not measured" outranks "context".
    expect(verdictOf(spec({ direction: null }), null)).toBe("not-measured");
  });

  it("issues no verdict for a context metric or one with no baseline", () => {
    expect(verdictOf(spec({ direction: null }), 5)).toBe("context");
    expect(verdictOf(spec({ baseline: null }), 5)).toBe("no-baseline");
  });

  it("a zero baseline makes ANY change non-flat rather than dividing by it", () => {
    expect(verdictOf(spec({ baseline: 0 }), 0)).toBe("flat");
    expect(verdictOf(spec({ baseline: 0 }), 1)).toBe("worse");
  });
});

describe("the baseline table", () => {
  it("has unique ids and records no baseline of its own", () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of METRICS) {
      expect(m.baseline, m.id).toBeNull();
      expect(m.source, m.id).toBeNull();
    }
  });

  it("applies the consumer's baselines by id and leaves the rest without one", () => {
    const specs = withBaselines(METRICS, {
      rounds_median: { value: 4, source: null },
    });
    expect(specs.find((m) => m.id === "rounds_median")?.baseline).toBe(4);
    expect(specs.find((m) => m.id === "rounds_p90")?.baseline).toBeNull();
    for (const m of SPECS.filter((s) => s.baseline !== null)) {
      const pin = PINNED[m.id] as { value: number; cites: string };
      expect(m.baseline as number, m.id).toBeCloseTo(pin.value, 10);
      expect(m.source?.needle, m.id).toBe(pin.cites);
    }
    expect(SPECS.filter((s) => s.baseline !== null).length).toBe(
      Object.keys(PINNED).length,
    );
  });

  it("names a configured baseline the catalogue has no metric for", () => {
    expect(
      unknownBaselineIds({
        ...BASELINES,
        rounds_mean: { value: 1, source: null },
      }),
    ).toEqual(["rounds_mean"]);
  });

  it("detects a citation that left its document, or a document that is gone", () => {
    const doc = Object.values(PINNED)
      .map((p) => p.cites)
      .join("\n");
    expect(baselineSourceProblems(SPECS, "/repo", () => doc)).toEqual([]);
    const drifted = baselineSourceProblems(SPECS, "/repo", () =>
      doc.replace("| p90 heads | 25 |", "| p90 heads | 24 |"),
    );
    expect(drifted).toEqual([
      'rounds_p90: baselines.md no longer contains "| p90 heads | 25 |"',
    ]);
    const missing = baselineSourceProblems(SPECS, "/repo", () => {
      throw new Error("ENOENT");
    });
    expect(missing.length).toBe(Object.keys(PINNED).length);
    expect(missing[0]).toContain("could not be read");
  });

  it("every spec is produced by currentValues when both sides were measured", () => {
    const pr = aggregatePrSide(
      [record({ threads: [row(1, "accepted")] })],
      BANDS,
      SEVERITIES,
    );
    const linear: LinearSide = {
      cohort: cohortStats([], {
        label: "follow-up",
        sinceMs: 0,
        untilMs: 86_400_000,
        nowMs: 86_400_000,
        closedStateTypes: [],
      }),
      epics: epicStats([], [], 0, 1),
      ledger: {
        total: 0,
        open: 0,
        closed: 0,
        windowDays: 1,
        minted: 0,
        closedInWindow: 0,
        mintedPerDay: 0,
        closedPerDay: 0,
        mintToCloseRatio: null,
        medianOpenAgeDays: null,
        oldestOpenAgeDays: null,
        priorityless: 0,
        prioritylessShare: 0,
        truncated: [],
      },
    };
    const values = currentValues(pr, linear);
    for (const m of METRICS)
      expect(Object.hasOwn(values, m.id), m.id).toBe(true);
  });

  it("maps every metric id to its own field — distinct inputs, expected outputs written out", () => {
    // heads [2, 4]: median 3. Threads: rounds 1,2 (first band), 7 (late) —
    // 1/3 late; outcomes accepted, accepted, rejected — 2/3 accepted.
    const pr = aggregatePrSide(
      [
        record({
          reviewedHeads: 2,
          threads: [row(1, "accepted"), row(7, "rejected", "medium", true)],
        }),
        record({
          pr: 2,
          reviewedHeads: 4,
          threads: [row(2, "accepted", "medium", false)],
        }),
      ],
      BANDS,
      SEVERITIES,
    );
    const cohort = {
      ...cohortStats([], {
        label: "follow-up",
        sinceMs: 0,
        untilMs: 86_400_000,
        nowMs: 86_400_000,
        closedStateTypes: [],
      }),
      mintsPerDay: 1.5,
      open: 2,
      closureShare: 0.25,
      prioritylessShare: 0.5,
      parentless: 3,
      medianOpenAgeDays: 4,
    };
    const linear: LinearSide = {
      cohort,
      epics: {
        total: 9,
        open: 5,
        started: 1,
        completed: 6,
        completedInWindow: 7,
      },
      ledger: {} as LinearSide["ledger"],
    };
    // Measured 2 of 2 eligible (rounds >= 2): 1 of 2 self-inflicted.
    expect(currentValues(pr, linear)).toEqual({
      merge_conflict_share: null,
      rounds_median: 3,
      rounds_p90: 4,
      late_round_thread_share: 1 / 3,
      self_inflicted_share: 0.5,
      accepted_share: 2 / 3,
      mints_per_day: 1.5,
      cohort_open: 2,
      cohort_closure_share: 0.25,
      priorityless_share: 0.5,
      parentless_open: 3,
      median_open_age_days: 4,
      epics_open: 5,
      epics_completed: 6,
      epics_completed_in_window: 7,
    });
  });
});

// ── Statistics ──────────────────────────────────────────────────────────────

describe("median / percentile / weekStartOf", () => {
  it("median averages the middle pair of an even sample and is null when empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("percentile is nearest-rank: a value that occurred, never an interpolation", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 0.9)).toBe(9);
    expect(percentile(ten, 1)).toBe(10);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.9)).toBeNull();
    expect(
      percentile(
        Array.from({ length: 43 }, (_, i) => i + 1),
        0.9,
      ),
    ).toBe(39);
  });

  it("weekStartOf is the Monday 00:00 UTC of the week, null on garbage", () => {
    expect(weekStartOf("2026-09-02T13:00:00Z")).toBe("2026-08-31"); // a Wednesday
    expect(weekStartOf("2026-08-31T00:00:00Z")).toBe("2026-08-31"); // the Monday itself
    expect(weekStartOf("2026-09-06T23:59:59Z")).toBe("2026-08-31"); // Sunday
    expect(weekStartOf("nonsense")).toBeNull();
  });
});

// ── Rounds and bands ────────────────────────────────────────────────────────

describe("bandIdOf", () => {
  it("cuts by the ladder bands, open-ended last band included", () => {
    expect(bandIdOf(BANDS, 1)).toBe("boy-scout");
    expect(bandIdOf(BANDS, 3)).toBe("boy-scout");
    expect(bandIdOf(BANDS, 4)).toBe("escalated");
    expect(bandIdOf(BANDS, 7)).toBe("late");
    expect(bandIdOf(BANDS, 400)).toBe("late");
  });

  it("a missing round and a round no band contains are named, never folded together", () => {
    expect(bandIdOf(BANDS, null)).toBe(UNKNOWN_ROUND);
    expect(bandIdOf(BANDS, 0)).toBe(OUTSIDE_BANDS);
  });
});

describe("roundIndexByHead", () => {
  it("numbers distinct initiating BOT heads in the order first reviewed", () => {
    const idx = roundIndexByHead(
      sample({
        reviews: [
          review("h2", "2026-09-01T02:00:00Z"),
          review("h1", "2026-09-01T01:00:00Z"),
          // Same head reviewed again by another bot: one round, not two.
          review("h1", "2026-09-01T01:30:00Z", { author: "other-bot" }),
          review("h3", "2026-09-01T03:00:00Z"),
        ],
      }),
    );
    expect([...idx.entries()]).toEqual([
      ["h1", 1],
      ["h2", 2],
      ["h3", 3],
    ]);
  });

  it("excludes a reply-only bot review and a human review — the reviewedHeads population", () => {
    const idx = roundIndexByHead(
      sample({
        reviews: [
          review("h1", "2026-09-01T01:00:00Z"),
          review("h2", "2026-09-01T02:00:00Z", { initiating: false }),
          review("h3", "2026-09-01T03:00:00Z", { isBot: false }),
        ],
      }),
    );
    expect([...idx.keys()]).toEqual(["h1"]);
  });
});

describe("buildPrRecord", () => {
  const s = sample({
    reviews: [
      review("h1", "2026-09-01T01:00:00Z"),
      review("h2", "2026-09-01T02:00:00Z"),
    ],
    threads: [
      thread({ threadId: "a", reviewedHeadOid: "h1" }),
      thread({
        threadId: "b",
        reviewedHeadOid: "h2",
        outcome: "wont-fix",
        severity: "low",
      }),
      // A head that was rewritten away: no round, never guessed.
      thread({ threadId: "c", reviewedHeadOid: "gone" }),
      thread({ threadId: "d", reviewedHeadOid: null }),
    ],
  });
  const rec = buildPrRecord(
    s,
    BANDS,
    new Map([
      ["a", true],
      ["b", false],
    ]),
  );

  it("counts reviewed heads and assigns each thread its round and band", () => {
    expect(rec.reviewedHeads).toBe(2);
    expect(rec.threads.map((t) => [t.round, t.band])).toEqual([
      [1, "boy-scout"],
      [2, "boy-scout"],
      [null, UNKNOWN_ROUND],
      [null, UNKNOWN_ROUND],
    ]);
  });

  it("carries outcome and severity through and reads a missing label as not measured", () => {
    expect(rec.threads[1]).toMatchObject({
      outcome: "wont-fix",
      severity: "low",
      selfInflicted: false,
    });
    expect(rec.threads[0]?.selfInflicted).toBe(true);
    expect(rec.threads[2]?.selfInflicted).toBeNull();
  });
});

// ── Aggregation ─────────────────────────────────────────────────────────────

describe("aggregatePrSide", () => {
  const records: PrRecord[] = [
    record({
      pr: 1,
      mergedAt: "2026-09-02T00:00:00Z", // week of 2026-08-31
      reviewedHeads: 4,
      threads: [
        // A round-1 thread cannot be fix-induced: a stray label on it is ignored.
        row(1, "accepted", "high", true),
        row(2, "accepted", "low", true),
        row(5, "wont-fix", "low", true),
        row(8, "accepted", "blocker", true),
        row(null, "accepted", "medium"),
        row(3, null, "medium"), // unanswered
      ],
    }),
    record({
      pr: 2,
      mergedAt: "2026-09-09T00:00:00Z", // week of 2026-09-07
      reviewedHeads: 10,
      threads: [
        row(1, "rejected", "medium", true),
        row(9, "deferred", "high", false),
      ],
    }),
    record({ pr: 3, reviewedHeads: 0, threads: [] }),
  ];
  const agg = aggregatePrSide(records, BANDS, SEVERITIES);

  it("rounds statistics are over PRs that had at least one reviewed head", () => {
    expect(agg.prs).toBe(3);
    expect(agg.prsWithRounds).toBe(2);
    expect(agg.rounds).toEqual({ median: 7, p90: 10, max: 10 });
  });

  it("accepted share is over ANSWERED threads only", () => {
    expect(agg.threads).toEqual({ total: 8, answered: 7, unknownRound: 1 });
    expect(agg.accepted).toEqual({ accepted: 4, answered: 7, share: 4 / 7 });
  });

  it("cuts by band × severity, keeping the ladder’s order and an unknown-round bucket", () => {
    expect(Object.keys(agg.byBand)).toEqual([
      "boy-scout",
      "escalated",
      "late",
      UNKNOWN_ROUND,
    ]);
    expect(agg.byBandSeverity["boy-scout"]?.high).toEqual({
      accepted: 1,
      answered: 1,
      share: 1,
    });
    expect(agg.byBandSeverity.late?.blocker).toEqual({
      accepted: 1,
      answered: 1,
      share: 1,
    });
    expect(agg.byBandSeverity.late?.high).toEqual({
      accepted: 0,
      answered: 1,
      share: 0,
    });
    expect(agg.byBand.escalated).toEqual({
      accepted: 0,
      answered: 1,
      share: 0,
    });
  });

  it("the late-round share is over threads with a KNOWN round, unanswered included", () => {
    // Known-round threads: 1,2,5,8,3 (pr1) + 1,9 (pr2) = 7; after boy-scout: 5, 8, 9.
    expect(agg.lateRoundThreadShare).toEqual({
      late: 3,
      total: 7,
      coverage: expect.any(Number),
      share: 3 / 7,
    });
  });

  it("reports self-inflicted over threads raised AFTER round 1, with coverage, by band and by week", () => {
    const si = agg.selfInflicted;
    // Eligible (known round >= 2): pr1 rounds 2,5,8,3 + pr2 round 9 = 5.
    // Labelled among them: 2,5,8 (true) and 9 (false) = 4; round 3 is unlabelled.
    // The two round-1 threads carry a label and must count for nothing.
    expect(si).toMatchObject({
      eligible: 5,
      measured: 4,
      selfInflicted: 3,
      share: 0.75,
      coverage: 0.8,
    });
    expect(si.byBand["boy-scout"]).toEqual({
      measured: 1,
      selfInflicted: 1,
      share: 1,
      eligible: 2,
      coverage: 0.5,
    });
    expect(si.byBand.late).toEqual({
      measured: 2,
      selfInflicted: 1,
      share: 0.5,
      eligible: 2,
      coverage: 1,
    });
    expect(si.byWeek).toEqual([
      {
        week: "2026-08-31",
        days: 7,
        measured: 3,
        selfInflicted: 3,
        share: 1,
        eligible: 4,
        coverage: 0.75,
      },
      {
        week: "2026-09-07",
        days: 7,
        measured: 1,
        selfInflicted: 0,
        share: 0,
        eligible: 1,
        coverage: 1,
      },
    ]);
  });

  it("a week bucket says how much of it is inside the PR window", () => {
    const labelled = (mergedAt: string): PrRecord =>
      record({ mergedAt, threads: [row(2, "accepted", "low", true)] });
    const agg2 = aggregatePrSide(
      [labelled("2026-09-24T00:00:00Z"), labelled("2026-09-28T12:00:00Z")],
      BANDS,
      SEVERITIES,
      {
        sinceMs: Date.parse("2026-09-22T00:00:00Z"),
        untilMs: Date.parse("2026-09-29T00:00:00Z"),
      },
    );
    // Mon 09-21's week holds 09-22..09-27 (6 days); Mon 09-28's holds only 09-28.
    expect(agg2.selfInflicted.byWeek.map((w) => [w.week, w.days])).toEqual([
      ["2026-09-21", 6],
      ["2026-09-28", 1],
    ]);
  });

  it("withholds the self-inflicted verdict below the coverage floor", () => {
    // 4 eligible threads, only 1 labelled: 25% coverage.
    const thin = aggregatePrSide(
      [
        record({
          threads: [
            row(2, "accepted", "low", true),
            row(3, "accepted", "low"),
            row(4, "accepted", "low"),
            row(5, "accepted", "low"),
          ],
        }),
      ],
      BANDS,
      SEVERITIES,
    );
    expect(thin.selfInflicted).toMatchObject({ share: 1, coverage: 0.25 });
    expect(currentValues(thin, null, SPECS).self_inflicted_share).toBeNull();
    const full = aggregatePrSide(
      [record({ threads: [row(2, "accepted", "low", true)] })],
      BANDS,
      SEVERITIES,
    );
    expect(currentValues(full, null, SPECS).self_inflicted_share).toBe(1);
  });

  it("withholds the late-round verdict when unknown-round threads could flip it", () => {
    const build = (late: number, early: number, unknown: number) =>
      aggregatePrSide(
        [
          record({
            threads: [
              ...Array.from({ length: late }, () => row(8, "accepted")),
              ...Array.from({ length: early }, () => row(1, "accepted")),
              ...Array.from({ length: unknown }, () => row(null, "accepted")),
            ],
          }),
        ],
        BANDS,
        SEVERITIES,
      );
    // 62/100 all-thread share if the 5 unknown are early (improved against
    // 69.8%), 67/100 if they are late (flat): the known-round share must not
    // be judged.
    const straddling = build(62, 33, 5);
    expect(
      currentValues(straddling, null, SPECS).late_round_thread_share,
    ).toBeNull();
    // Both ends of the interval land in the same band: judged.
    const safe = build(30, 65, 5);
    expect(currentValues(safe, null, SPECS).late_round_thread_share).toBe(
      30 / 95,
    );
    // Every round known: no interval to straddle.
    const complete = build(62, 38, 0);
    expect(currentValues(complete, null, SPECS).late_round_thread_share).toBe(
      0.62,
    );
  });

  it("applies the coverage floor to each self-inflicted band row", () => {
    const agg3 = aggregatePrSide(
      [
        record({
          threads: [
            // late band: 1 of 3 eligible measured.
            row(8, "accepted", "low", true),
            row(8, "accepted", "low"),
            row(8, "accepted", "low"),
            // boy-scout band: 9 of 9 measured lifts the overall coverage to 10/12.
            ...Array.from({ length: 9 }, () =>
              row(2, "accepted", "low", false),
            ),
          ],
        }),
      ],
      BANDS,
      SEVERITIES,
    );
    expect(agg3.selfInflicted.byBand.late).toMatchObject({
      eligible: 3,
      measured: 1,
    });
    expect(agg3.selfInflicted.byBand.late?.coverage).toBeCloseTo(1 / 3);
    const md = renderScoreboard({
      version: 1,
      generatedAt: "2026-09-29T00:00:00.000Z",
      window: {
        until: "2026-09-30T00:00:00.000Z",
        pr: { since: "2026-09-23T00:00:00.000Z", days: 7 },
        linear: { since: "2026-08-24T00:00:00.000Z", days: 37 },
      },
      pr: agg3,
      linear: null,
      metrics: [],
      gaps: [],
      caveats: [],
      escapeAnchor: null,
    } as never);
    expect(md).toMatch(/band `late` \(1\/3 eligible measured.*\| withheld \|/);
  });

  it("an empty population is null everywhere — not measured, never 0%", () => {
    const empty = aggregatePrSide([], BANDS, SEVERITIES);
    expect(empty.rounds).toEqual({ median: null, p90: null, max: null });
    expect(empty.accepted.share).toBeNull();
    expect(empty.lateRoundThreadShare.share).toBeNull();
    expect(empty.selfInflicted.share).toBeNull();
    expect(empty.selfInflicted.coverage).toBeNull();
  });

  it('with no bands there is no "late" and the share is not measured', () => {
    const noBands = aggregatePrSide(records, [], SEVERITIES);
    expect(noBands.lateRoundThreadShare.share).toBeNull();
  });
});

describe("cohortStats", () => {
  const DAY = 86_400_000;
  const since = Date.parse("2026-07-26T00:00:00Z");
  const until = Date.parse("2026-09-01T00:00:00Z");
  const win = {
    label: "follow-up",
    sinceMs: since,
    untilMs: until,
    nowMs: until,
    closedStateTypes: ["completed", "canceled", "duplicate"],
  };
  const issue = (
    over: Partial<Parameters<typeof cohortStats>[0][number]> = {},
  ) => ({
    createdAt: "2026-08-15T00:00:00Z",
    stateType: "unstarted",
    priority: 0,
    parent: null,
    labels: ["follow-up"],
    ...over,
  });

  it("the window is half-open: the start instant is in, the end instant is out", () => {
    const c = cohortStats(
      [
        issue({ createdAt: "2026-07-26T00:00:00Z" }),
        issue({ createdAt: "2026-08-31T23:59:59Z" }),
        issue({ createdAt: "2026-09-01T00:00:00Z" }),
        issue({ createdAt: "2026-07-25T23:59:59Z" }),
      ],
      win,
    );
    expect(c.minted).toBe(2);
    expect(c.days).toBe(37);
  });

  it("only issues carrying the label are in the cohort", () => {
    expect(
      cohortStats([issue({ labels: ["epic"] }), issue()], win).minted,
    ).toBe(1);
  });

  it("open/closed split, and priorityless/parentless/age are over the OPEN population", () => {
    const c = cohortStats(
      [
        issue({ priority: 0, parent: null, createdAt: "2026-08-22T00:00:00Z" }), // open, 10d
        issue({
          priority: 2,
          parent: "ENG-1",
          createdAt: "2026-08-12T00:00:00Z",
        }), // open, 20d
        issue({ priority: 0, parent: null, stateType: "completed" }), // closed: counts nowhere below
        issue({ priority: 0, stateType: "duplicate" }),
      ],
      win,
    );
    expect(c).toMatchObject({
      minted: 4,
      open: 2,
      closed: 2,
      closureShare: 0.5,
    });
    expect(c).toMatchObject({
      priorityless: 1,
      prioritylessShare: 0.5,
      parentless: 1,
    });
    expect(c.medianOpenAgeDays).toBe(15);
    expect(c.mintsPerDay).toBeCloseTo(4 / 37);
    expect(DAY).toBe(86_400_000);
  });

  it("an empty cohort has null shares, not 0%", () => {
    const c = cohortStats([], win);
    expect(c).toMatchObject({
      minted: 0,
      closureShare: null,
      prioritylessShare: null,
      medianOpenAgeDays: null,
    });
  });

  it("refuses an unparseable createdAt rather than shortening the cohort", () => {
    expect(() => cohortStats([issue({ createdAt: "yesterday" })], win)).toThrow(
      /unparseable createdAt/,
    );
  });
});

describe("cohortStats — truncated label lists", () => {
  const W = {
    label: "follow-up",
    sinceMs: 0,
    untilMs: 10 * 86_400_000,
    nowMs: 10 * 86_400_000,
    closedStateTypes: ["completed"],
  };
  const issue = (over: object) => ({
    createdAt: "1970-01-02T00:00:00Z",
    stateType: "started",
    priority: 0,
    parent: null,
    labels: [] as string[],
    ...over,
  });

  it("refuses when an issue outside the read labels may carry the cohort label on a later page", () => {
    expect(() =>
      cohortStats([issue({ labels: ["bug"], truncated: ["labels"] })], W),
    ).toThrow(/truncated label list/);
  });

  it("accepts a truncated issue that already shows the label, and other truncated fields", () => {
    const stats = cohortStats(
      [
        issue({ labels: ["follow-up"], truncated: ["labels"] }),
        issue({ labels: ["bug"], truncated: ["comments"] }),
      ],
      W,
    );
    expect(stats.minted).toBe(1);
  });

  it("ignores a truncated, label-less issue created outside the window", () => {
    const stats = cohortStats(
      [
        issue({
          labels: ["bug"],
          truncated: ["labels"],
          createdAt: "1969-01-01T00:00:00Z",
        }),
        issue({ labels: ["follow-up"] }),
      ],
      W,
    );
    expect(stats.minted).toBe(1);
  });
});

describe("epicStats", () => {
  it("counts open, started, completed, and completions inside the window", () => {
    const e = epicStats(
      [
        { stateType: "started", completedAt: null },
        { stateType: "unstarted", completedAt: null },
        { stateType: "completed", completedAt: "2026-09-10T00:00:00Z" },
        { stateType: "completed", completedAt: "2026-06-01T00:00:00Z" },
        { stateType: "canceled", completedAt: null },
      ],
      ["completed", "canceled", "duplicate"],
      Date.parse("2026-09-01T00:00:00Z"),
      Date.parse("2026-10-01T00:00:00Z"),
    );
    expect(e).toEqual({
      total: 5,
      open: 2,
      started: 1,
      completed: 2,
      completedInWindow: 1,
    });
  });
});

// ── Rows and rendering ──────────────────────────────────────────────────────

describe("metricRows / renderScoreboard", () => {
  it("a requested side with no value is a not-measured row, not a missing one", () => {
    const rows = metricRows(new Set(["pr", "linear"]), {}, SPECS);
    expect(rows.length).toBe(METRICS.length);
    expect(rows.every((r) => r.verdict === "not-measured")).toBe(true);
  });

  it("a skipped side contributes no rows", () => {
    const rows = metricRows(new Set(["pr"]), { rounds_median: 4 }, SPECS);
    expect(rows.every((r) => r.side === "pr")).toBe(true);
    expect(rows.find((r) => r.id === "rounds_median")).toMatchObject({
      baseline: 10,
      current: 4,
      delta: -6,
      verdict: "improved",
    });
  });

  it("a week with eligible threads but none measured stays in the trend, marked not measured", () => {
    const agg3 = aggregatePrSide(
      [
        // Week of 09-14: 9 measured of 10 eligible.
        record({
          mergedAt: "2026-09-15T00:00:00Z",
          threads: [
            ...Array.from({ length: 9 }, () => row(2, "accepted", "low", true)),
            row(2, "accepted", "low"),
          ],
        }),
        // Week of 09-21: 0 measured of 1 eligible.
        record({
          pr: 2,
          mergedAt: "2026-09-22T00:00:00Z",
          threads: [row(2, "accepted", "low")],
        }),
      ],
      BANDS,
      SEVERITIES,
    );
    expect(agg3.selfInflicted.byWeek).toEqual([
      {
        week: "2026-09-14",
        days: 7,
        measured: 9,
        selfInflicted: 9,
        share: 1,
        eligible: 10,
        coverage: 0.9,
      },
      {
        week: "2026-09-21",
        days: 7,
        measured: 0,
        selfInflicted: 0,
        share: null,
        eligible: 1,
        coverage: 0,
      },
    ]);
  });

  it("does not print a headline self-inflicted percentage the verdict has withheld", () => {
    const thin = aggregatePrSide(
      [
        record({
          threads: [
            row(2, "accepted", "low", true),
            row(3, "accepted", "low"),
            row(4, "accepted", "low"),
            row(5, "accepted", "low"),
          ],
        }),
      ],
      BANDS,
      SEVERITIES,
    );
    const text = renderScoreboard({
      version: 1,
      generatedAt: "2026-09-29T00:00:00.000Z",
      window: {
        until: "2026-09-30T00:00:00.000Z",
        pr: { since: "2026-09-23T00:00:00.000Z", days: 7 },
        linear: { since: "2026-08-24T00:00:00.000Z", days: 37 },
      },
      pr: thin,
      linear: null,
      metrics: metricRows(
        new Set(["pr"]),
        currentValues(thin, null, SPECS),
        SPECS,
      ),
      escapeAnchor: "defect-escape anchor: unmeasured for a current window",
      caveats: [],
    });
    expect(text).toContain(
      "1 of 1 measured threads (share withheld: coverage is below the 90% floor or the unmeasured threads could move the verdict)",
    );
    expect(text).not.toContain("100.0% of 1 measured threads");
  });

  it("renders the verdict table, the band table and the caveats", () => {
    const pr = aggregatePrSide(
      [
        record({
          reviewedHeads: 6,
          threads: [
            row(1, "accepted", "high", true),
            row(5, "wont-fix", "low", false),
          ],
        }),
      ],
      BANDS,
      SEVERITIES,
    );
    const text = renderScoreboard({
      version: 1,
      generatedAt: "2026-09-29T00:00:00.000Z",
      window: {
        until: "2026-09-30T00:00:00.000Z",
        pr: { since: "2026-09-23T00:00:00.000Z", days: 7 },
        linear: { since: "2026-08-24T00:00:00.000Z", days: 37 },
      },
      pr,
      linear: null,
      metrics: metricRows(
        new Set(["pr"]),
        currentValues(pr, null, SPECS),
        SPECS,
      ),
      escapeAnchor: "defect-escape anchor: unmeasured for a current window",
      caveats: ["PARTIAL: something"],
    });
    expect(text).toContain("## Verdicts vs the recorded baseline");
    expect(text).toContain("| Bot-reviewed heads per PR — median | 10 | 6 |");
    expect(text).toContain("**improved**");
    expect(text).toContain("### Accepted share by round band and severity");
    expect(text).toContain("| boy-scout |");
    expect(text).toContain(
      "coverage 100.0% of the 1 threads raised after the first reviewed head",
    );
    expect(text).toContain("- PARTIAL: something");
    expect(text).not.toContain("## Linear side");
  });
});

// ── The composition main() runs ─────────────────────────────────────────────

const NOW = Date.parse("2026-09-29T12:00:00Z");

const LINEAR: LinearSide = {
  cohort: cohortStats([], {
    label: "follow-up",
    sinceMs: Date.parse("2026-08-24T00:00:00Z"),
    untilMs: Date.parse("2026-09-30T00:00:00Z"),
    nowMs: NOW,
    closedStateTypes: [],
  }),
  epics: { total: 0, open: 0, started: 0, completed: 0, completedInWindow: 0 },
  ledger: {
    total: 1,
    open: 1,
    closed: 0,
    windowDays: 37,
    minted: 1,
    closedInWindow: 0,
    mintedPerDay: 0,
    closedPerDay: 0,
    mintToCloseRatio: null,
    medianOpenAgeDays: null,
    oldestOpenAgeDays: null,
    priorityless: 0,
    prioritylessShare: 0,
    truncated: [],
  },
};

function deps(over: Partial<RunDeps> = {}): {
  d: RunDeps;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    list: [],
    sample: [],
    linear: [],
  };
  const d: RunDeps = {
    nowMs: () => NOW,
    listMergedPrs: async (...a) => {
      calls.list?.push(a);
      return [
        { number: 10, title: "a", mergedAt: "2026-09-20T00:00:00Z" },
        { number: 11, title: "b", mergedAt: "2026-09-21T00:00:00Z" },
      ];
    },
    samplePr: async (n, asOf) => {
      calls.sample?.push([n, asOf]);
      return sample({
        pr: n,
        reviews: [
          review(`h${n}a`, "2026-09-20T00:00:00Z"),
          review(`h${n}b`, "2026-09-20T01:00:00Z"),
        ],
        threads: [thread({ threadId: `t${n}`, reviewedHeadOid: `h${n}b` })],
      });
    },
    labelSelfInflicted: async (s) =>
      new Map(s.threads.map((t) => [t.threadId, true])),
    loadLadder: async () => ({ bands: BANDS, severityOrder: SEVERITIES }),
    fetchLinear: async (w) => {
      calls.linear?.push([w]);
      return LINEAR;
    },
    specs: SPECS,
    note: () => {},
    ...over,
  };
  return { d, calls };
}

const OPTS = {
  until: "2026-09-30",
  days: 37,
  prDays: 7,
  limit: 300,
  concurrency: 2,
  skipPrs: false,
  skipLinear: false,
};

describe("runScoreboard", () => {
  it("resolves the half-open window into an inclusive search range and asks for limit+1", async () => {
    const { d, calls } = deps();
    const { scoreboard, gaps } = await runScoreboard(OPTS, d);
    // PR side [2026-09-23, 2026-09-30) — the search's own range is inclusive,
    // so it ends the day before — while the Linear cohort keeps its 37 days.
    expect(calls.list?.[0]).toEqual(["2026-09-23", "2026-09-29", 301]);
    expect(calls.linear?.[0]?.[0]).toMatchObject({
      sinceMs: Date.parse("2026-08-24T00:00:00Z"),
      untilMs: Date.parse("2026-09-30T00:00:00Z"),
    });
    expect(scoreboard.window).toEqual({
      until: "2026-09-30T00:00:00.000Z",
      pr: { since: "2026-09-23T00:00:00.000Z", days: 7 },
      linear: { since: "2026-08-24T00:00:00.000Z", days: 37 },
    });
    expect(gaps).toEqual([]);
    expect(scoreboard.pr?.prs).toBe(2);
    expect(scoreboard.pr?.selfInflicted).toMatchObject({
      measured: 2,
      selfInflicted: 2,
    });
    expect(scoreboard.linear).toBe(LINEAR);
  });

  it("freezes outcomes at the window end only when that end is in the past", async () => {
    const future = deps();
    await runScoreboard(OPTS, future.d);
    expect(future.calls.sample?.map((c) => c[1])).toEqual([
      undefined,
      undefined,
    ]);

    const past = deps();
    await runScoreboard({ ...OPTS, until: "2026-09-01" }, past.d);
    expect(past.calls.sample?.map((c) => c[1])).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
  });

  it("flags a capped window as PARTIAL instead of truncating silently", async () => {
    const { d } = deps({
      listMergedPrs: async () => [
        { number: 1, title: "", mergedAt: "2026-09-01T00:00:00Z" },
        { number: 2, title: "", mergedAt: "2026-09-02T00:00:00Z" },
        { number: 3, title: "", mergedAt: "2026-09-03T00:00:00Z" },
      ],
    });
    const { scoreboard, gaps } = await runScoreboard({ ...OPTS, limit: 2 }, d);
    expect(scoreboard.pr?.prs).toBe(2);
    expect(gaps.join()).toMatch(/more than --limit 2/);
    expect(scoreboard.caveats[0]).toStartWith("PARTIAL:");
    // The newest-N subset is not the window: no PR-side verdict may be issued.
    for (const m of scoreboard.metrics.filter((r) => r.side === "pr")) {
      expect(m.current).toBeNull();
      expect(m.verdict).toBe("not-measured");
    }
  });

  it("withholds window-bound Linear verdicts when --days differs from the baseline window", async () => {
    const { d } = deps({ fetchLinear: async () => LINEAR });
    const { scoreboard } = await runScoreboard({ ...OPTS, days: 1 }, d);
    for (const id of [
      "mints_per_day",
      "cohort_open",
      "cohort_closure_share",
      "priorityless_share",
      "parentless_open",
      "median_open_age_days",
      "epics_completed_in_window",
    ]) {
      expect(scoreboard.metrics.find((m) => m.id === id)?.current).toBeNull();
    }
    expect(scoreboard.caveats.join()).toMatch(
      /--days 1 differs from the 37-day window/,
    );
  });

  it("renders the defect-escape anchor beside the speed figures", () => {
    expect(
      renderScoreboard({
        version: 1,
        generatedAt: "2026-09-29T00:00:00.000Z",
        window: {
          until: "2026-09-30T00:00:00.000Z",
          pr: { since: "2026-09-23T00:00:00.000Z", days: 7 },
          linear: { since: "2026-08-24T00:00:00.000Z", days: 37 },
        },
        pr: null,
        linear: null,
        metrics: [],
        escapeAnchor: "defect-escape anchor: unmeasured for a current window",
        caveats: [],
      }),
    ).toContain("defect-escape anchor: unmeasured for a current window");
  });

  it("an unreadable PR is named and absent from the aggregate — never counted as empty", async () => {
    const { d } = deps({
      samplePr: async (n) => {
        if (n === 11) throw new Error("graphql boom");
        return sample({
          pr: n,
          reviews: [review("h", "2026-09-20T00:00:00Z")],
          threads: [],
        });
      },
    });
    const { scoreboard, gaps } = await runScoreboard(OPTS, d);
    expect(scoreboard.pr?.prs).toBe(1);
    expect(gaps).toEqual([
      "1 PR(s) could not be sampled and are absent from the review figures, so review verdicts are withheld; conflict records can still cover them: #11",
      // Its one sampled PR carries no post-first-round thread, so the
      // self-inflicted population is absent, not merely thin.
      "no thread was raised after the first reviewed head, so self-inflicted has no population and reads not-measured",
    ]);
    // The partial counts stay as context, but no PR-side figure is judged
    // against a baseline recorded over a different population.
    const prRows = scoreboard.metrics.filter((m) => m.side === "pr");
    expect(prRows.length).toBeGreaterThan(0);
    expect(prRows.every((m) => m.verdict === "not-measured")).toBe(true);
    expect(prRows.every((m) => m.current === null)).toBe(true);
    const linearRows = scoreboard.metrics.filter((m) => m.side === "linear");
    expect(linearRows.some((m) => m.verdict !== "not-measured")).toBe(true);
  });

  it("a failed Linear side is a gap and not-measured rows, while the PR side still lands", async () => {
    const { d } = deps({
      fetchLinear: async () => {
        throw new Error("no Linear credential");
      },
    });
    const { scoreboard, gaps } = await runScoreboard(OPTS, d);
    expect(gaps[0]).toContain(
      "the Linear side could not be measured: no Linear credential",
    );
    expect(scoreboard.pr).not.toBeNull();
    expect(scoreboard.linear).toBeNull();
    const linearRows = scoreboard.metrics.filter((m) => m.side === "linear");
    expect(linearRows.length).toBeGreaterThan(0);
    expect(linearRows.every((m) => m.verdict === "not-measured")).toBe(true);
  });

  it("--skip-linear neither calls Linear nor produces Linear rows nor a gap", async () => {
    const { d, calls } = deps();
    const { scoreboard, gaps } = await runScoreboard(
      { ...OPTS, skipLinear: true },
      d,
    );
    expect(calls.linear).toEqual([]);
    expect(gaps).toEqual([]);
    expect(scoreboard.metrics.every((m) => m.side === "pr")).toBe(true);
  });

  it("--skip-prs never lists or samples", async () => {
    const { d, calls } = deps();
    const { scoreboard } = await runScoreboard({ ...OPTS, skipPrs: true }, d);
    expect(calls.list).toEqual([]);
    expect(calls.sample).toEqual([]);
    expect(scoreboard.pr).toBeNull();
    expect(scoreboard.metrics.every((m) => m.side === "linear")).toBe(true);
  });

  it("without a labeller self-inflicted is skipped, says so, and is not-measured", async () => {
    const { d } = deps({ labelSelfInflicted: null });
    const { scoreboard } = await runScoreboard(OPTS, d);
    expect(scoreboard.pr?.selfInflicted.measured).toBe(0);
    expect(scoreboard.caveats.join("\n")).toContain(
      "Self-inflicted was skipped",
    );
    expect(
      scoreboard.metrics.find((m) => m.id === "self_inflicted_share")?.verdict,
    ).toBe("not-measured");
  });

  it("warns that Linear is as-of-now for a past window, and not for a current one", async () => {
    const cur = await runScoreboard(OPTS, deps().d);
    expect(cur.scoreboard.caveats.join("\n")).not.toContain("AS OF NOW");
    const past = await runScoreboard(
      { ...OPTS, until: "2026-09-01" },
      deps().d,
    );
    expect(past.scoreboard.caveats.join("\n")).toContain("AS OF NOW");
  });

  it("a metric with no recorded baseline says its first measurement carries no verdict", async () => {
    const specs = SPECS.map((m) =>
      m.id === "rounds_p90" ? { ...m, baseline: null, source: null } : m,
    );
    const { scoreboard } = await runScoreboard(OPTS, deps({ specs }).d);
    expect(scoreboard.caveats.join("\n")).toContain(
      'No recorded baseline for "Bot-reviewed heads per PR — p90"',
    );
    expect(scoreboard.metrics.find((m) => m.id === "rounds_p90")?.verdict).toBe(
      "no-baseline",
    );
  });

  it("only a metric that lacks a baseline gets the first-measurement caveat", async () => {
    const { scoreboard } = await runScoreboard(OPTS, deps().d);
    const noBaseline = scoreboard.caveats.filter((c) =>
      c.startsWith("No recorded baseline"),
    );
    expect(noBaseline.length).toBe(
      SPECS.filter((m) => m.baseline === null).length,
    );
    expect(noBaseline.join("\n")).toContain(
      "Epics completed inside the window",
    );
    expect(noBaseline.join("\n")).not.toContain("p90");
  });

  it("an empty PR window is a gap, never a clean run of not-measured rows", async () => {
    const { gaps, scoreboard } = await runScoreboard(
      OPTS,
      deps({ listMergedPrs: async () => [] }).d,
    );
    expect(gaps).toContain("no merged PRs in the PR window");
    expect(scoreboard.pr?.prs).toBe(0);
  });

  it("PRs with no bot-reviewed head are a gap of their own", async () => {
    const { gaps } = await runScoreboard(
      OPTS,
      deps({
        samplePr: async (n) => sample({ pr: n, reviews: [], threads: [] }),
      }).d,
    );
    expect(gaps).toContain("no PR in the window has a bot-reviewed head");
  });

  it("withholds the self-inflicted share when unmeasured threads could flip its verdict", () => {
    const base = aggregatePrSide(
      [record({ threads: [row(2, "accepted", "medium", true)] })],
      BANDS,
      SEVERITIES,
    );
    const spec = SPECS.find((m) => m.id === "self_inflicted_share");
    expect(spec?.baseline).not.toBeNull();
    const b = spec?.baseline ?? 0;
    // 100 eligible, 90 measured (coverage exactly at the floor): the measured
    // share sits well below the baseline while the ten unmeasured threads could
    // all be self-inflicted and land it back on the baseline.
    const si = {
      ...base.selfInflicted,
      eligible: 100,
      measured: 90,
      selfInflicted: Math.round(b * 100) - 10,
      coverage: 0.9,
      share: (Math.round(b * 100) - 10) / 90,
    };
    expect(
      judgedSelfInflictedShare({ ...base, selfInflicted: si }, SPECS),
    ).toBeNull();
  });

  it("withholds a week row whose population the headline has withheld", () => {
    const base = aggregatePrSide(
      [record({ threads: [row(2, "accepted", "medium", true)] })],
      BANDS,
      SEVERITIES,
    );
    const b = SPECS.find((m) => m.id === "self_inflicted_share")?.baseline ?? 0;
    const sTrue = Math.round(b * 100) - 10;
    const week = {
      week: "2026-09-21",
      days: 7,
      eligible: 100,
      measured: 90,
      selfInflicted: sTrue,
      coverage: 0.9,
      share: sTrue / 90,
    };
    const pr = {
      ...base,
      selfInflicted: {
        ...base.selfInflicted,
        eligible: 100,
        measured: 90,
        selfInflicted: sTrue,
        coverage: 0.9,
        share: sTrue / 90,
        byBand: {},
        byWeek: [week],
      },
    };
    expect(judgedSelfInflictedShare(pr, SPECS)).toBeNull();
    expect(cutShareIsPublishable(pr, week, SPECS)).toBe(false);
    const text = renderScoreboard({
      version: 1,
      generatedAt: "2026-09-29T00:00:00.000Z",
      window: {
        until: "2026-09-30T00:00:00.000Z",
        pr: { since: "2026-09-23T00:00:00.000Z", days: 7 },
        linear: { since: "2026-08-24T00:00:00.000Z", days: 37 },
      },
      pr,
      linear: null,
      metrics: metricRows(
        new Set(["pr"]),
        currentValues(pr, null, SPECS),
        SPECS,
      ),
      escapeAnchor: "defect-escape anchor: unmeasured for a current window",
      caveats: [],
    });
    expect(text).toMatch(/week of 2026-09-21 .*\| withheld \|/);
    expect(text).not.toContain(`${(week.share * 100).toFixed(1)}%`);
  });

  it("publishes an interval-judged share as approximate, with no point delta", () => {
    const base = aggregatePrSide(
      [record({ threads: [row(2, "accepted", "medium", true)] })],
      BANDS,
      SEVERITIES,
    );
    const si = {
      ...base.selfInflicted,
      eligible: 100,
      measured: 95,
      selfInflicted: 0,
      coverage: 0.95,
      share: 0,
    };
    const pr = { ...base, selfInflicted: si };
    expect(judgedSelfInflictedShare(pr, SPECS)).toBe(0);
    const bounded = boundedMetricIds(pr, SPECS);
    expect(bounded.has("self_inflicted_share")).toBe(true);
    const row_ = metricRows(
      new Set(["pr"]),
      { self_inflicted_share: 0 },
      SPECS,
      bounded,
    ).find((m) => m.id === "self_inflicted_share");
    expect(row_).toMatchObject({ bounded: true, delta: null });
  });

  it("a withheld row is never marked approximate", () => {
    const row_ = metricRows(
      new Set(["pr"]),
      { self_inflicted_share: null },
      SPECS,
      new Set(["self_inflicted_share"]),
    ).find((m) => m.id === "self_inflicted_share");
    expect(row_).toMatchObject({ bounded: false, current: null });
  });

  it("a window where no thread has a recoverable round is a gap, not a clean run", async () => {
    const { gaps, scoreboard } = await runScoreboard(
      OPTS,
      deps({
        samplePr: async (n) =>
          sample({
            pr: n,
            reviews: [review(`h${n}a`, "2026-09-20T00:00:00Z")],
            threads: [thread({ threadId: `t${n}`, reviewedHeadOid: "gone" })],
          }),
      }).d,
    );
    expect(gaps.join("\n")).toMatch(/no recoverable round/);
    expect(
      scoreboard.metrics.find((m) => m.id === "late_round_thread_share")
        ?.verdict,
    ).toBe("not-measured");
  });

  it("records the epic count as context: its baseline is an approximation", () => {
    expect(METRICS.find((m) => m.id === "epics_open")?.direction).toBeNull();
  });

  it("thin self-inflicted coverage is a gap and withholds the verdict", async () => {
    const { gaps, scoreboard } = await runScoreboard(
      OPTS,
      deps({ labelSelfInflicted: async () => new Map() }).d,
    );
    expect(gaps.join("\n")).toMatch(
      /self-inflicted coverage is 0\.0%.*below the 90% floor/,
    );
    expect(
      scoreboard.metrics.find((m) => m.id === "self_inflicted_share")?.verdict,
    ).toBe("not-measured");
  });
});

describe("parseArgs", () => {
  const TODAY = Date.parse("2026-09-29T12:00:00Z");

  it("defaults to a 7-day PR window and a 37-day cohort, both ending tomorrow so today is in", () => {
    expect(parseArgs([], TODAY)).toMatchObject({
      until: "2026-09-30",
      days: 37,
      prDays: 7,
      limit: 300,
      json: false,
      out: null,
      skipPrs: false,
      skipLinear: false,
      skipSelfInflicted: false,
      fetchHeads: true,
    });
  });

  it("reads every flag", () => {
    expect(
      parseArgs(
        [
          "--days",
          "30",
          "--pr-days",
          "14",
          "--until",
          "2026-08-13",
          "--limit",
          "60",
          "--concurrency",
          "2",
          "--json",
          "--out",
          "x.md",
          "--skip-linear",
          "--skip-self-inflicted",
          "--no-fetch-heads",
        ],
        TODAY,
      ),
    ).toMatchObject({
      days: 30,
      prDays: 14,
      until: "2026-08-13",
      limit: 60,
      concurrency: 2,
      json: true,
      out: "x.md",
      skipLinear: true,
      skipSelfInflicted: true,
      fetchHeads: false,
    });
  });

  it("rejects the inputs that would silently change what is measured", () => {
    expect(() => parseArgs(["--until", "2026-02-31"], TODAY)).toThrow();
    expect(() => parseArgs(["--days", "0"], TODAY)).toThrow();
    expect(() => parseArgs(["--pr-days", "0"], TODAY)).toThrow();
    expect(() => parseArgs(["--days", "1e3"], TODAY)).toThrow();
    expect(() => parseArgs(["--days"], TODAY)).toThrow();
    expect(() => parseArgs(["--out"], TODAY)).toThrow();
    expect(() => parseArgs(["--bogus"], TODAY)).toThrow();
    expect(() => parseArgs(["--skip-prs", "--skip-linear"], TODAY)).toThrow();
  });
});

// ── The Linear-side adapters ────────────────────────────────────────────────

describe("ledgerContextOf", () => {
  const NOW = Date.parse("2026-09-30T00:00:00Z");
  const DAY = 86_400_000;
  const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  const ledger = (
    over: Partial<Parameters<typeof ledgerContextOf>[0][number]>,
  ) => ({
    identifier: "ENG-1",
    createdAt: at(5),
    completedAt: null,
    canceledAt: null,
    stateType: "backlog",
    priority: 2,
    parent: null,
    project: null,
    labels: ["follow-up"],
    truncated: [],
    ...over,
  });
  const CLOSED = ["completed", "canceled", "duplicate"];

  it("counts the population, the window's flow and the open issues' age", () => {
    const ctx = ledgerContextOf(
      [
        ledger({ identifier: "ENG-1", createdAt: at(2), priority: 0 }),
        ledger({ identifier: "ENG-2", createdAt: at(40) }),
        ledger({ identifier: "ENG-3", createdAt: at(12) }),
        ledger({
          identifier: "ENG-4",
          createdAt: at(50),
          stateType: "completed",
          completedAt: at(3),
        }),
        ledger({
          identifier: "ENG-5",
          createdAt: at(20),
          stateType: "canceled",
          canceledAt: at(1),
        }),
        // Closed with no instant: in no window.
        ledger({
          identifier: "ENG-6",
          createdAt: at(60),
          stateType: "duplicate",
        }),
      ],
      CLOSED,
      30,
      NOW,
    );
    expect(ctx).toEqual({
      total: 6,
      open: 3,
      closed: 3,
      windowDays: 30,
      minted: 3,
      closedInWindow: 2,
      mintedPerDay: 0.1,
      closedPerDay: 0.07,
      mintToCloseRatio: 1.5,
      medianOpenAgeDays: 12,
      oldestOpenAgeDays: 40,
      priorityless: 1,
      prioritylessShare: 0.3333,
      truncated: [],
    });
  });

  it("reports an unmeasurable ratio and a truncated read rather than inventing them", () => {
    const ctx = ledgerContextOf(
      [ledger({ truncated: ["labels"] })],
      CLOSED,
      30,
      NOW,
    );
    expect(ctx.mintToCloseRatio).toBeNull();
    expect(ctx.truncated).toEqual(["ENG-1:labels"]);
    expect(ledgerContextOf([], CLOSED, 30, NOW)).toMatchObject({
      medianOpenAgeDays: null,
      oldestOpenAgeDays: null,
      prioritylessShare: 0,
    });
  });
});

// ── The retroactive self-inflicted labeller, against a real repository ─────

describe("makeSelfInflictedLabeler — real git", () => {
  let repo = "";
  let firstSha = ""; // the head the first bot review was submitted against
  let headSha = ""; // a later head, after two post-review fix commits
  let orphanSha = ""; // a commit with no relation to the branch
  let mergeSha = "";

  const env = (): Record<string, string> =>
    gitIdentityEnv() as Record<string, string>;
  function git(args: string[]): string {
    const p = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: env(),
    });
    if (p.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  }

  // 60s: this hook spawns a dozen `git` subprocesses and bun's 5s default is
  // killed mid-spawn under this repo's concurrent-suite load, surfacing as a
  // git failure with empty stderr.
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "drive-pr-fractal-"));
    git(["init", "-q", "."]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "f.txt"), "base-1\nbase-2\nbase-3\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    git(["branch", "-M", "main"]);
    git(["checkout", "-q", "-b", "feature"]);
    // The PR's OPENING work: written by the PR, before any review.
    writeFileSync(join(repo, "f.txt"), "base-1\nOPEN-2\nbase-3\nOPEN-4\n");
    git(["commit", "-q", "-am", "opening work"]);
    firstSha = git(["rev-parse", "HEAD"]);
    // Two POST-review fix commits.
    writeFileSync(join(repo, "f.txt"), "base-1\nFIX-2\nbase-3\nOPEN-4\n");
    git(["commit", "-q", "-am", "fix line 2"]);
    writeFileSync(
      join(repo, "f.txt"),
      "base-1\nFIX-2\nbase-3\nOPEN-4\nFIX-5\n",
    );
    git(["commit", "-q", "-am", "add line 5"]);
    // The base branch moves on and the PR syncs it in AFTER review began: the
    // merged-in commit is not this PR's work, and `^<base>` is what says so.
    git(["checkout", "-q", "main"]);
    writeFileSync(join(repo, "g.txt"), "imported-1\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base moves on"]);
    git(["checkout", "-q", "feature"]);
    git(["merge", "--no-ff", "-q", "-m", "sync base", "main"]);
    headSha = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "--orphan", "unrelated"]);
    writeFileSync(join(repo, "other.txt"), "x\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "unrelated orphan"]);
    orphanSha = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "main"]);
    // A merge commit whose FIRST parent is the base tip — `mergeCommit^1`.
    git(["merge", "--no-ff", "-q", "-m", "merge feature", "feature"]);
    mergeSha = git(["rev-parse", "HEAD"]);
  }, 60_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  const t = (id: string, over: Partial<ThreadSample>): ThreadSample =>
    thread({
      threadId: id,
      path: "f.txt",
      reviewedHeadOid: headSha,
      originalLine: 2,
      ...over,
    });

  const reviewedAt = (oid: string, at: string): ReviewSample =>
    review(oid, `2026-09-01T${at}:00Z`);

  const reviews = (): ReviewSample[] => [
    reviewedAt(firstSha, "01:00"),
    reviewedAt(headSha, "02:00"),
  ];

  it("labels a line written AFTER review began true, and opening or base lines false", async () => {
    const label = makeSelfInflictedLabeler(repo, false);
    const out = await label(
      sample({
        pr: 7,
        mergeCommitOid: mergeSha,
        reviews: reviews(),
        threads: [
          t("fix", { originalLine: 2 }),
          t("fix-late", { originalLine: 5 }),
          // Written by the PR, but BEFORE review began: `self-inflicted.ts`
          // would call this `true`; a fix cannot have induced it.
          t("opening", { originalLine: 4 }),
          t("base", { originalLine: 1 }),
          // Landed after review began, but on the BASE branch, then synced in.
          t("imported", { path: "g.txt", originalLine: 1 }),
        ],
      }),
    );
    expect(out.get("fix")).toBe(true);
    expect(out.get("fix-late")).toBe(true);
    expect(out.get("opening")).toBe(false);
    expect(out.get("base")).toBe(false);
    expect(out.get("imported")).toBe(false);
  }, 60_000);

  it("leaves round 1 and every unanswerable thread unmeasured — never false", async () => {
    const label = makeSelfInflictedLabeler(repo, false);
    const out = await label(
      sample({
        pr: 7,
        mergeCommitOid: mergeSha,
        reviews: reviews(),
        threads: [
          // Raised on the first reviewed head: no fix preceded it.
          t("round-1", { reviewedHeadOid: firstSha }),
          t("left", { diffSide: "LEFT" }),
          t("no-side", { diffSide: null }),
          t("no-path", { path: null }),
          t("no-line", { originalLine: null }),
          t("gone-head", { reviewedHeadOid: "0".repeat(40) }),
        ],
      }),
    );
    expect(out.size).toBe(0);
  }, 60_000);

  it("a first reviewed head that is not an ancestor (history rewritten) makes it unanswerable", async () => {
    const label = makeSelfInflictedLabeler(repo, false);
    const out = await label(
      sample({
        pr: 7,
        mergeCommitOid: mergeSha,
        reviews: [reviewedAt(orphanSha, "01:00"), reviewedAt(headSha, "02:00")],
        threads: [t("fix", { originalLine: 2 })],
      }),
    );
    expect(out.size).toBe(0);
  }, 60_000);

  it("a failed fetch is reported but not fatal — local objects still label", async () => {
    // This repository has no `origin`, so every fetch fails; the heads are
    // local, so the labels must still come out, and the failure must be said.
    const notes: string[] = [];
    const label = makeSelfInflictedLabeler(repo, true, (m) => notes.push(m));
    const out = await label(
      sample({
        pr: 7,
        baseRefName: "main",
        mergeCommitOid: mergeSha,
        reviews: reviews(),
        threads: [t("fix", { originalLine: 2 })],
      }),
    );
    expect(out.get("fix")).toBe(true);
    expect(notes.some((n) => /git fetch .* failed/.test(n))).toBe(true);
  }, 60_000);

  it("measures nothing without a merge commit to take the base from, or without a review", async () => {
    const label = makeSelfInflictedLabeler(repo, false);
    expect(
      (
        await label(
          sample({
            mergeCommitOid: "",
            reviews: reviews(),
            threads: [t("x", {})],
          }),
        )
      ).size,
    ).toBe(0);
    expect(
      (
        await label(
          sample({
            mergeCommitOid: mergeSha,
            reviews: [],
            threads: [t("x", {})],
          }),
        )
      ).size,
    ).toBe(0);
  });

  it("never throws: an unusable repository is a coverage loss, not a lost PR", async () => {
    const label = makeSelfInflictedLabeler(join(repo, "does-not-exist"), false);
    const out = await label(
      sample({
        mergeCommitOid: mergeSha,
        reviews: reviews(),
        threads: [t("x", {})],
      }),
    );
    expect(out.size).toBe(0);
  });
});
