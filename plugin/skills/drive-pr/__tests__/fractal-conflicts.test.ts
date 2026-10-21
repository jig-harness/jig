import { describe, expect, it } from "bun:test";
import {
  conflictCoverage,
  forgeProvesNoForcePush,
  judgedConflictShare,
  observeConflicts,
  renderConflictCoverage,
  replaySince,
  type ConflictDeps,
  type ConflictEvidence,
  type ConflictObservation,
} from "../scripts/lib/fractal-conflicts.ts";
import { METRICS, withBaselines } from "../scripts/lib/fractal-baseline.ts";
import type { PrSample } from "../scripts/lib/sample.ts";
import { runScoreboard, type RunDeps } from "../scripts/fractal-metrics.ts";
import { parseConfig } from "../scripts/lib/fleet-health-config.ts";
import { readFileSync } from "node:fs";
import { load as loadYaml } from "../../../shared/yaml.ts";

const specs = withBaselines(METRICS, {
  merge_conflict_share: { value: 0.5, source: null },
});
const cohort = Array.from({ length: 100 }, (_, i) => i + 1);
function observations(conflicted: number, clean: number) {
  return new Map(
    cohort
      .slice(0, conflicted + clean)
      .map(
        (id, i) =>
          [id, i < conflicted ? "conflicted" : "observed-clean"] as [
            number,
            ConflictObservation,
          ],
      ),
  );
}
const sample = {
  pr: 1,
  headRefOid: "head",
  mergeCommitOid: "merge",
  mergedAt: "2026-10-20T00:00:00Z",
} as PrSample;
const report = {
  schema: "merge-conflicts/v1",
  shallow: false,
  merges: [],
  skipped: [],
} as unknown as NonNullable<ConflictEvidence["report"]>;
function deps(over: Partial<ConflictDeps> = {}): ConflictDeps {
  return {
    evidence: async () => ({ report, events: [] }),
    ancestry: async () => ({ commits: new Set(["head"]), merges: new Set() }),
    noForcePush: async () => true,
    ...over,
  };
}

describe("merge-conflict scoreboard coverage", () => {
  it("checks filtered forge nodes instead of the unfiltered timeline totalCount", () => {
    const body = (nodes: unknown) => ({
      data: {
        repository: {
          pullRequest: {
            headRefOid: "head",
            timelineItems: { totalCount: 35, nodes },
          },
        },
      },
    });
    expect(forgeProvesNoForcePush(body([]), "head")).toBe(true);
    expect(
      forgeProvesNoForcePush(
        body([{ __typename: "HeadRefForcePushedEvent" }]),
        "head",
      ),
    ).toBe(false);
    expect(forgeProvesNoForcePush(body(undefined), "head")).toBe(false);
    expect(forgeProvesNoForcePush(body([]), "other-head")).toBe(false);
    expect(
      forgeProvesNoForcePush({ ...body([]), errors: ["outage"] }, "head"),
    ).toBe(false);
  });
  it("deduplicates PRs and never counts live silence as clean", () => {
    const c = conflictCoverage(
      [1, 1, 2, 3],
      new Map([
        [1, "conflicted"],
        [2, "observed-clean"],
      ]),
      0.9,
    );
    expect(c).toMatchObject({
      cohort: 3,
      conflicted: 1,
      observedClean: 1,
      unknown: 1,
      share: 0.5,
      coverage: 2 / 3,
    });
    expect(c.bounds).toEqual({ low: 1 / 3, high: 2 / 3 });
    expect(judgedConflictShare(c, specs)).toBeNull();
    expect(renderConflictCoverage(c)).toContain("1 unknown of 3 merged PRs");
  });
  it("withholds below the configured floor even with stable endpoints", () => {
    const c = conflictCoverage(cohort, observations(10, 70), 0.9);
    expect(judgedConflictShare(c, specs)).toBeNull();
    expect(judgedConflictShare({ ...c, coverageFloor: 0.8 }, specs)).toBe(
      0.125,
    );
  });
  it("withholds at the floor when unknown PRs cross a verdict edge", () => {
    const c = conflictCoverage(cohort, observations(45, 45), 0.9);
    expect(c.coverage).toBe(0.9);
    expect(c.bounds).toEqual({ low: 0.45, high: 0.55 });
    expect(judgedConflictShare(c, specs)).toBeNull();
  });
  it("publishes a measured share only when both whole-cohort endpoints agree", () => {
    const c = conflictCoverage(cohort, observations(10, 80), 0.9);
    expect(judgedConflictShare(c, specs)).toBe(10 / 90);
    expect(
      judgedConflictShare(conflictCoverage([], new Map(), 0), specs),
    ).toBeNull();
  });
  it("counts repeated replay/live records once per PR, including an unreadable sample", async () => {
    const d = deps({
      evidence: async () => ({
        report: {
          ...report,
          merges: [
            {
              commit: "head",
              conflicted: true,
              pullRequest: 1,
              date: sample.mergedAt,
            },
          ],
        } as NonNullable<ConflictEvidence["report"]>,
        events: [
          {
            type: "merge_conflict",
            commit: "head",
            path: "a",
            pr: 1,
            ts: sample.mergedAt as string,
          },
        ],
      }),
    });
    expect((await observeConflicts([sample], d)).get(1)).toBe("conflicted");
    expect(
      (
        await observeConflicts([], d, [
          { number: 1, mergedAt: sample.mergedAt as string },
        ])
      ).get(1),
    ).toBe("conflicted");
  });
  it("sees a branch-sync conflict even when the final forge merge is clean", async () => {
    const d = deps({
      ancestry: async () => ({
        commits: new Set(["sync", "head"]),
        merges: new Set(["sync"]),
      }),
      evidence: async () => ({
        report: {
          ...report,
          merges: [{ commit: "sync", conflicted: true, pullRequest: null }],
        } as NonNullable<ConflictEvidence["report"]>,
        events: [],
      }),
    });
    expect((await observeConflicts([sample], d)).get(1)).toBe("conflicted");
  });
  it("counts the final merge by commit even with a custom subject", async () => {
    const d = deps({
      evidence: async () => ({
        report: {
          ...report,
          merges: [{ commit: "merge", conflicted: true, pullRequest: null }],
        } as typeof report,
        events: [],
      }),
    });
    expect((await observeConflicts([sample], d)).get(1)).toBe("conflicted");
  });
  it("keeps a skipped final merge unknown", async () => {
    const d = deps({
      ancestry: async () => ({
        commits: new Set(["head", "merge"]),
        merges: new Set(["merge"]),
      }),
    });
    expect((await observeConflicts([sample], d)).get(1)).toBe("unknown");
  });
  it("requires complete replayed ancestry and a successful no-force-push probe", async () => {
    expect((await observeConflicts([sample], deps())).get(1)).toBe(
      "observed-clean",
    );
    for (const d of [
      deps({ noForcePush: async () => false }),
      deps({
        noForcePush: async () => {
          throw new Error("forge outage");
        },
      }),
      deps({ ancestry: async () => null }),
      deps({
        ancestry: async () => {
          throw new Error("missing head");
        },
      }),
      deps({
        ancestry: async () => ({
          commits: new Set(["sync"]),
          merges: new Set(["sync"]),
        }),
      }),
      deps({
        evidence: async () => ({
          report: { ...report, shallow: true },
          events: [],
        }),
      }),
    ]) {
      expect((await observeConflicts([sample], d)).get(1)).toBe("unknown");
    }
  });
  it("ignores another PR's conflict and a stale PR mark after this PR merged", async () => {
    const d = deps({
      evidence: async () => ({
        report,
        events: [
          {
            type: "merge_conflict",
            commit: "other",
            path: "a",
            pr: 2,
            ts: "2026-10-19T00:00:00Z",
          },
          {
            type: "merge_conflict",
            commit: "later",
            path: "b",
            pr: 1,
            ts: "2026-10-21T00:00:00Z",
          },
        ],
      }),
    });
    expect((await observeConflicts([sample], d)).get(1)).toBe("observed-clean");
  });
  it("keeps live evidence when replay is unavailable", async () => {
    const d = deps({
      evidence: async () => ({
        report: null,
        complete: false,
        events: [
          {
            type: "merge_conflict",
            commit: "rewritten",
            path: "a",
            pr: 1,
            ts: "2026-10-19T00:00:00Z",
          },
        ],
      }),
    });
    expect(
      (await observeConflicts([sample, { ...sample, pr: 2 }], d)).get(1),
    ).toBe("conflicted");
    expect(
      (await observeConflicts([sample, { ...sample, pr: 2 }], d)).get(2),
    ).toBe("unknown");
  });
  it("retains direct conflict evidence if the head/forge probes fail", async () => {
    const d = deps({
      ancestry: async () => {
        throw new Error("head gone");
      },
      noForcePush: async () => {
        throw new Error("forge gone");
      },
      evidence: async () => ({
        report,
        events: [
          {
            type: "merge_conflict",
            commit: "rewritten",
            path: "a",
            pr: 1,
            ts: "2026-10-19T00:00:00Z",
          },
        ],
      }),
    });
    expect((await observeConflicts([sample], d)).get(1)).toBe("conflicted");
  });
  it("loads old fleet files and validates the optional coverage floor", () => {
    const raw = loadYaml(
      readFileSync(
        new URL("fixtures/fleet-health.yaml", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(parseConfig(raw).mergeConflicts.coverageFloor).toBe(0.9);
    expect(
      parseConfig({ ...raw, merge_conflicts: { coverage_floor: 0.75 } })
        .mergeConflicts.coverageFloor,
    ).toBe(0.75);
    for (const floor of [-0.1, 1.1, "0.9"])
      expect(() =>
        parseConfig({ ...raw, merge_conflicts: { coverage_floor: floor } }),
      ).toThrow();
  });
  it("uses the forge cohort even when review sampling fails, and wires the metric row", async () => {
    const d: RunDeps = {
      specs,
      nowMs: () => Date.parse("2026-10-21T12:00:00Z"),
      listMergedPrs: async () => [
        { number: 1, mergedAt: sample.mergedAt as string, title: "change" },
      ],
      samplePr: async () => {
        throw new Error("review unavailable");
      },
      loadLadder: async () => ({ bands: [], severityOrder: [] }),
      labelSelfInflicted: null,
      fetchLinear: async () => {
        throw new Error("not requested");
      },
      note: () => undefined,
      observeConflicts: async (_samples, prs) => {
        expect(prs.map((p) => p.number)).toEqual([1]);
        return new Map([[1, "conflicted"]]);
      },
    };
    const { scoreboard } = await runScoreboard(
      {
        until: "2026-10-22",
        prDays: 7,
        days: 37,
        limit: 300,
        concurrency: 1,
        skipPrs: false,
        skipLinear: true,
      },
      d,
    );
    expect(scoreboard.mergeConflicts).toMatchObject({
      cohort: 1,
      conflicted: 1,
      coverage: 1,
    });
    expect(
      scoreboard.metrics.find((m) => m.id === "merge_conflict_share"),
    ).toMatchObject({ current: 1, verdict: "worse" });
    expect(scoreboard.caveats.join()).toContain("this clone's live events");
    d.listMergedPrs = async () => [
      { number: 1, title: "one", mergedAt: sample.mergedAt as string },
      { number: 2, title: "two", mergedAt: sample.mergedAt as string },
    ];
    const capped = await runScoreboard(
      {
        until: "2026-10-22",
        prDays: 7,
        days: 37,
        limit: 1,
        concurrency: 1,
        skipPrs: false,
        skipLinear: true,
      },
      d,
    );
    expect(capped.scoreboard.mergeConflicts).toMatchObject({
      cohortCapped: true,
      bounds: null,
    });
    expect(
      capped.scoreboard.metrics.find((m) => m.id === "merge_conflict_share")
        ?.verdict,
    ).toBe("not-measured");
    expect(
      renderConflictCoverage(
        capped.scoreboard.mergeConflicts as NonNullable<
          typeof scoreboard.mergeConflicts
        >,
      ),
    ).toContain("full cohort bounds unavailable");
  });
});

describe("the replay's window", () => {
  const withCommits = (createdAt: string, ...dates: string[]) =>
    ({
      ...sample,
      createdAt,
      commits: dates.map((committedDate) => ({ committedDate })),
    }) as PrSample;
  it("starts at the earliest sampled commit, PR opening or cohort merge", () => {
    expect(
      replaySince(
        [
          withCommits("2026-10-10T00:00:00Z", "2026-10-08T12:00:00Z"),
          withCommits("2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z"),
        ],
        [{ number: 9, mergedAt: "2026-10-15T00:00:00Z" }],
      ),
    ).toBe("2026-10-08T12:00:00.000Z");
    expect(
      replaySince([], [{ number: 9, mergedAt: "2026-10-15T00:00:00Z" }]),
    ).toBe("2026-10-15T00:00:00.000Z");
  });
  it("replays the whole history when nothing dates the cohort", () => {
    expect(replaySince([], [])).toBeNull();
    expect(replaySince([withCommits("not a date")], [])).toBeNull();
  });
  it("hands the collector the samples and cohort it bounds", async () => {
    const seen: unknown[] = [];
    const cohortPrs = [{ number: 1, mergedAt: "2026-10-20T00:00:00Z" }];
    await observeConflicts(
      [sample],
      deps({
        evidence: async (samples, listed) => {
          seen.push(samples, listed);
          return { report, events: [] };
        },
      }),
      cohortPrs,
    );
    expect(seen).toEqual([[sample], cohortPrs]);
  });
});
