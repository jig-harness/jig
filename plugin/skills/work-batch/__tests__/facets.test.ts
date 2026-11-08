/**
 * work-batch where the repository keeps size and type as issue facets: the
 * pool read by the size facet, the gaps by the facets an issue lacks, the
 * batch sizes read whatever store size is in, and today's label reading
 * where the taxonomy has no size group.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../scripts/candidates.ts";
import { describeReason, excludeReason } from "../scripts/lib/eligibility.ts";
import { batchPolicy } from "../scripts/lib/policy.ts";
import {
  catalog,
  facetPolicy,
  fakeTracker,
  issue,
  OVERLAY,
  policy,
  relabel,
  taxonomyFacets,
} from "./helpers.ts";

const F = facetPolicy();
/** The pool labels an issue carries, with no size label: the size is the facet's. */
const base = relabel(issue("ENG-0").labels, ["small"]);
/** An eligible small bug, its type and size in their facets. */
const faceted = (key: string, over: Parameters<typeof issue>[1] = {}) =>
  issue(key, { labels: base, type: "bug", size: "small", ...over });
const opts = () => ({
  limit: F.maxItems,
  budget: F.pointBudget,
  claimed: new Set<string>(),
});
const ids = (list: ReadonlyArray<{ identifier: string }>) =>
  list.map((i) => i.identifier);

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "work-batch-facets-"));
  scratch.push(dir);
  return dir;
}

describe("the pool, by the size facet", () => {
  it("reads the batchable sizes from the size facet, never from size labels", async () => {
    const tracker = fakeTracker([
      faceted("ENG-1"),
      faceted("ENG-2", { size: "large" }),
      faceted("ENG-3", { size: null, labels: [...base, "small"] }),
    ]);
    const p = await run(tracker, catalog(), F, "billing", opts(), root());
    expect(tracker.queries[0]).toEqual({
      withSomeOf: [["area:billing"]],
      facets: { oneOf: { size: ["xs", "small", "medium"] } },
    });
    expect(ids(p.candidates)).toEqual(["ENG-1"]);
    expect(p.candidates[0]).toMatchObject({ size: "small", points: 2 });
  });

  it("lists an issue that lacks a priority or a size as a gap, and nothing else", async () => {
    const tracker = fakeTracker([
      faceted("ENG-1"),
      faceted("ENG-2", { priority: 0 }),
      faceted("ENG-3", { size: null }),
      faceted("ENG-4", { priority: 0, size: null }),
      faceted("ENG-5", { size: null, labels: [...base, "epic"] }),
      faceted("ENG-6", { priority: 0, size: "xl" }),
    ]);
    const p = await run(tracker, catalog(), F, "billing", opts(), root());
    expect(tracker.queries[1]).toEqual({
      withSomeOf: [["area:billing"]],
      facets: { missing: ["priority", "size"] },
    });
    expect(ids(p.candidates)).toEqual(["ENG-1"]);
    expect(p.labellingGaps.map((g) => [g.identifier, g.missing])).toEqual([
      ["ENG-2", ["priority"]],
      ["ENG-3", ["size"]],
      ["ENG-4", ["priority", "size"]],
    ]);
    expect(ids(p.excluded)).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it("holds back an epic's child with no priority as a gap", async () => {
    const epic = faceted("ENG-9", { labels: [...base, "epic"] });
    const tracker = fakeTracker([epic], {
      children: {
        "ENG-9": [faceted("ENG-10"), faceted("ENG-11", { priority: 0 })],
      },
    });
    const p = await run(tracker, catalog(), F, "ENG-9", opts(), root());
    expect(ids(p.candidates)).toEqual(["ENG-10"]);
    expect(p.labellingGaps.map((g) => [g.identifier, g.missing])).toEqual([
      ["ENG-11", ["priority"]],
    ]);
  });
});

describe("eligibility, by the facets", () => {
  const none = { claimed: new Set<string>() };

  it("holds back an issue with no size, naming the sizes to set", () => {
    const reason = excludeReason(faceted("ENG-1", { size: null }), F, none);
    expect(reason).toEqual({ kind: "not-batchable-size", size: null });
    expect(describeReason(reason as NonNullable<typeof reason>, F)).toBe(
      "no size; set one of `xs`, `small`, `medium` if it fits, and re-run",
    );
  });

  it("reads the type from the type facet, never from type labels", () => {
    expect(excludeReason(faceted("ENG-1"), F, none)).toBeNull();
    expect(
      excludeReason(
        faceted("ENG-1", { type: null, labels: [...base, "feature"] }),
        F,
        none,
      ),
    ).toEqual({ kind: "no-type-label" });
  });
});

describe("the batch sizes, whatever store size is in", () => {
  it("reads each size setting as a size value or as the label of one", () => {
    const overlay = {
      ...OVERLAY,
      issue_tracker: {
        adapter: "linear",
        team: "ENG",
        facets: { size: { store: "label", prefix: "size:" } },
        labels: { batch_sizes: ["size:xs", "size:small"] },
      },
      work_batch: {
        sizes: ["size:xs", "size:small", "large"],
        size_points: { "size:xs": 1, small: 3 },
        ranking: { sizes: { "size:small": 4 } },
      },
    };
    const p = batchPolicy(overlay, catalog(), taxonomyFacets(overlay));
    expect(p.facets).toBe(true);
    expect(p.batchSizes).toEqual(["xs", "small"]);
    expect(p.sizes).toEqual(["xs", "small", "large"]);
    expect({ ...p.sizePoints }).toEqual({ xs: 1, small: 3 });
    expect({ ...p.ranking.sizes }).toEqual({ small: 4 });
  });

  it("keeps reading sizes and types from labels where the taxonomy has no size group", async () => {
    const p = batchPolicy(OVERLAY, catalog(), taxonomyFacets(OVERLAY, null));
    expect(p.facets).toBe(false);
    expect(p).toEqual(policy());
    const tracker = fakeTracker([issue("ENG-1")]);
    const proposal = await run(
      tracker,
      catalog(),
      p,
      "billing",
      opts(),
      root(),
    );
    expect(tracker.queries[0]).toEqual({
      withSomeOf: [["area:billing"], ["xs", "small", "medium"]],
    });
    expect(ids(proposal.candidates)).toEqual(["ENG-1"]);
  });

  it("lists an issue in the pool with no priority as a gap where sizes are labels", async () => {
    const tracker = fakeTracker([
      issue("ENG-1"),
      issue("ENG-2", { priority: 0 }),
    ]);
    const p = await run(
      tracker,
      catalog(),
      policy(),
      "billing",
      opts(),
      root(),
    );
    expect(ids(p.candidates)).toEqual(["ENG-1"]);
    expect(p.labellingGaps.map((g) => [g.identifier, g.missing])).toEqual([
      ["ENG-2", ["priority"]],
    ]);
  });
});
