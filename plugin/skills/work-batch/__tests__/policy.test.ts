/**
 * The batch policy read from configuration: the defaults a repository that
 * sets nothing gets, the solo-only flags no setting can remove, and the
 * shape rules of the `work_batch` section.
 */
import { describe, expect, it } from "bun:test";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  batchPolicy,
  DEFAULT_MAX_ITEMS,
  DEFAULT_POINT_BUDGET,
  DEFAULT_RANKING,
  DEFAULT_SIZE_POINTS,
  parseWorkBatchSection,
} from "../scripts/lib/policy.ts";
import { catalog, OVERLAY, policy } from "./helpers.ts";

describe("defaults", () => {
  it("pins the budget, the points, the item limit and the ranking weights", () => {
    const p = batchPolicy({}, null);
    expect(DEFAULT_POINT_BUDGET).toBe(16);
    expect(DEFAULT_MAX_ITEMS).toBe(6);
    expect(DEFAULT_SIZE_POINTS).toEqual({ xs: 1, small: 2, medium: 6 });
    expect(DEFAULT_RANKING).toEqual({
      sizes: { xs: 2, small: 1, medium: 0 },
      provenance: 3,
      sharedAreaLabel: 1,
    });
    expect(p.pointBudget).toBe(16);
    expect(p.maxItems).toBe(6);
    expect({ ...p.sizePoints }).toEqual({ xs: 1, small: 2, medium: 6 });
    expect({ ...p.ranking.sizes }).toEqual({ xs: 2, small: 1, medium: 0 });
    expect(p.ranking.provenance).toBe(3);
    expect(p.ranking.sharedAreaLabel).toBe(1);
    expect(p.batchSizes).toEqual(["xs", "small", "medium"]);
    expect(p.sizes).toBeNull();
    expect(p.followupLabel).toBe("pr-followup");
  });

  it("checks no repository, type or context label the repository does not name", () => {
    const p = batchPolicy({}, null);
    expect(p.repoLabel).toBeNull();
    expect(p.typeLabels).toBeNull();
    expect(p.contextPrefixes).toBeNull();
  });
});

describe("solo-only flags", () => {
  it("derives the hitl and manual-ops labels, the hitl facets and every catalog flag", () => {
    const p = policy({ work_batch: { solo_flags: ["privacy-review"] } });
    expect(p.soloFlags).toEqual([
      "api-review",
      "db-migration",
      "hitl",
      "manual-ops",
      "privacy-review",
    ]);
    expect(p.soloFlagPrefixes).toEqual(["hitl:"]);
  });

  it("follows the repository's names for the label roles", () => {
    const p = policy({
      issue_tracker: {
        team: "ENG",
        labels: { hitl: "needs-human", manual_ops: "ops-step" },
      },
    });
    expect(p.soloFlags).toContain("needs-human");
    expect(p.soloFlags).toContain("ops-step");
    expect(p.soloFlags).not.toContain("hitl");
    expect(p.soloFlagPrefixes).toEqual(["needs-human:"]);
  });

  it("lets no setting remove a derived flag", () => {
    const derived = ["api-review", "db-migration", "hitl", "manual-ops"];
    // Every way a setting could try: an empty or null list, the flags
    // listed again, other label roles and the other fields of the section.
    const attempts: Record<string, unknown>[] = [
      {},
      { work_batch: { solo_flags: [] } },
      { work_batch: { solo_flags: null } },
      { work_batch: { solo_flags: ["hitl", "api-review"] } },
      { work_batch: { sizes: ["xs", "small", "medium", "hitl"] } },
      {
        work_batch: {
          point_budget: 100,
          max_items: 50,
          ranking: { provenance: 0, shared_area_label: 0 },
        },
      },
      {
        issue_tracker: {
          team: "ENG",
          labels: {
            extractable_tails: ["hitl:legal"],
            batch_sizes: ["xs", "small", "medium"],
            followup: "hitl",
          },
        },
      },
      {
        review: {
          repo_label: "hitl",
          taxonomy: {
            repos: ["hitl"],
            types: ["manual-ops"],
            ownership_prefixes: ["team:"],
          },
        },
      },
      {
        do_item: {
          agents: { codearea_areas: { "db-migration": "infra" } },
        },
      },
    ];
    for (const extra of attempts) {
      const p = policy(extra);
      for (const flag of derived)
        expect([
          JSON.stringify(extra),
          flag,
          p.soloFlags.includes(flag),
        ]).toEqual([JSON.stringify(extra), flag, true]);
      expect(p.soloFlagPrefixes).toContain("hitl:");
    }
    // A field meant to remove one is refused, not ignored.
    expect(() =>
      policy({ work_batch: { solo_flags_remove: ["hitl"] } }),
    ).toThrow("work_batch.solo_flags_remove is not a field of work_batch");
    expect(() => policy({ work_batch: { solo_flags: "none" } })).toThrow(
      "work_batch.solo_flags must be a list",
    );
  });

  it("reads every flag of every catalog area, the older linear: spelling too", () => {
    const old = parseCatalog({
      areas: { a: { paths: ["a/**"], linear: { flags: ["legacy-flag"] } } },
    });
    expect(batchPolicy(OVERLAY, old).soloFlags).toContain("legacy-flag");
  });
});

describe("the work_batch section", () => {
  it("requires size_points to price exactly the batchable sizes", () => {
    const sizes = ["s", "m"];
    expect(() => parseWorkBatchSection({}, sizes)).toThrow(
      "work_batch.size_points must be set",
    );
    expect(() =>
      parseWorkBatchSection({ work_batch: { size_points: { s: 1 } } }, sizes),
    ).toThrow("must price exactly issue_tracker.labels.batch_sizes (s, m)");
    expect(() =>
      parseWorkBatchSection(
        { work_batch: { size_points: { s: 1, m: 3, l: 9 } } },
        sizes,
      ),
    ).toThrow("must price exactly");
    expect(
      parseWorkBatchSection(
        { work_batch: { size_points: { m: 3, s: 1 } } },
        sizes,
      ).sizePoints,
    ).toEqual({ m: 3, s: 1 });
    expect(() =>
      parseWorkBatchSection(
        { work_batch: { size_points: { s: 0, m: 3 } } },
        sizes,
      ),
    ).toThrow("work_batch.size_points.s must be a whole number ≥ 1");
  });

  it("requires sizes, when listed, to hold every batchable size", () => {
    expect(() =>
      parseWorkBatchSection({ work_batch: { sizes: ["xs", "large"] } }, [
        "xs",
        "small",
        "medium",
      ]),
    ).toThrow("it lacks small, medium");
  });

  it("replaces only the ranking weights it names", () => {
    const s = parseWorkBatchSection(
      { work_batch: { ranking: { provenance: 5 } } },
      ["xs", "small", "medium"],
    );
    expect(s.ranking.provenance).toBe(5);
    expect(s.ranking.sharedAreaLabel).toBe(1);
    expect({ ...s.ranking.sizes }).toEqual({ xs: 2, small: 1, medium: 0 });
    expect(() =>
      parseWorkBatchSection(
        { work_batch: { ranking: { sizes: { large: 1 } } } },
        ["xs", "small", "medium"],
      ),
    ).toThrow("work_batch.ranking.sizes.large is not a batchable size");
    expect(() =>
      parseWorkBatchSection({ work_batch: { ranking: { priority: 1 } } }, [
        "xs",
        "small",
        "medium",
      ]),
    ).toThrow("work_batch.ranking.priority is not a field");
  });

  it("gives a batch size named like an Object property the default weight 0", () => {
    const sizes = ["xs", "constructor", "__proto__", "toString"];
    const p = policy({
      issue_tracker: { team: "ENG", labels: { batch_sizes: sizes } },
      work_batch: {
        sizes,
        size_points: { xs: 1, constructor: 2, ["__proto__"]: 3, toString: 4 },
      },
    });
    expect({ ...p.ranking.sizes }).toEqual({
      xs: 2,
      constructor: 0,
      ["__proto__"]: 0,
      toString: 0,
    });
    expect(Object.getPrototypeOf(p.ranking.sizes)).toBeNull();
  });

  it("refuses limits below one", () => {
    for (const field of ["point_budget", "max_items"])
      expect(() =>
        parseWorkBatchSection({ work_batch: { [field]: 0 } }, [
          "xs",
          "small",
          "medium",
        ]),
      ).toThrow(`work_batch.${field} must be a whole number ≥ 1`);
  });
});

describe("the labels the policy reads from other sections", () => {
  it("takes the area-naming labels from do_item.agents.codearea_areas", () => {
    const p = policy();
    expect(p.areaNaming["area:billing"]).toBe("billing");
    expect(p.areaNamingSpelling["area:billing"]).toBe("area:billing");
    expect(p.areaLabelPrefixes).toEqual(["area:"]);
    expect(p.knownAreaLabels).toContain("domain:payments");
  });

  it("queries a case-colliding area-naming label in the spelling whose area it routes to", () => {
    const p = policy({
      do_item: {
        agents: {
          codearea_areas: { "Area:Docs": "old", "area:docs": "docs" },
        },
      },
    });
    expect(p.areaNaming["area:docs"]).toBe("docs");
    expect(p.areaNamingSpelling["area:docs"]).toBe("area:docs");
  });

  it("refuses a repository label outside the repository taxonomy", () => {
    expect(() =>
      policy({
        review: {
          repo_label: "mobile",
          taxonomy: { repos: ["web"], ownership_prefixes: ["team:"] },
        },
      }),
    ).toThrow("review.repo_label mobile is not one of review.taxonomy.repos");
  });

  it("reads the catalog it is given and none when there is none", () => {
    expect(policy({}, null).soloFlags).toEqual(["hitl", "manual-ops"]);
    expect(policy({}, catalog()).soloFlags).toContain("db-migration");
  });
});
