import { describe, expect, it } from "bun:test";
import {
  facetInputs,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import { resolveFacets } from "../scripts/lib/tracker/facets/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import { checkLinearFacets } from "../scripts/lib/tracker/linear-facets.ts";
import { JIG_TAXONOMY } from "./github-fixtures.ts";

type Call = { query: string; variables: Record<string, unknown> };

const page = (nodes: unknown[]) => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});

/** A team's estimate settings, as `teams` answers them. */
interface Estimates {
  type: string;
  extended?: boolean;
  zero?: boolean;
}

const FIBONACCI: Estimates = { type: "fibonacci" };

/** A pool node with its estimate (left out where `estimate` is undefined). */
function poolNode(estimate?: number | null): Record<string, unknown> {
  return {
    identifier: "ENG-1",
    title: "t",
    url: null,
    priority: 3,
    ...(estimate === undefined ? {} : { estimate }),
    createdAt: "2026-01-01T00:00:00Z",
    state: { id: "s", name: "Todo", type: "unstarted" },
    assignee: null,
    labels: page([{ name: "bug" }]),
    children: page([]),
  };
}

/** An issue node of the single-issue read, with its estimate. */
function issueNode(estimate?: number | null): Record<string, unknown> {
  return {
    id: "uuid-1",
    identifier: "ENG-1",
    title: "t",
    description: "",
    url: null,
    priority: 2,
    ...(estimate === undefined ? {} : { estimate }),
    state: { name: "Todo", type: "unstarted" },
    labels: page([{ name: "bug" }]),
    parent: null,
    children: page([]),
    assignee: null,
    project: null,
  };
}

const LABELS = ["bug", "small"].map((name) => ({
  id: `l-${name}`,
  name,
  isGroup: false,
  parent: null,
}));

/**
 * A Linear tracker over a fake transport, with `section` as its
 * `issue_tracker`, the team's estimates, the estimate its issues hold, and
 * the taxonomy's sizes.
 */
function linear(
  section: Record<string, unknown>,
  estimates: Estimates = FIBONACCI,
  read: { estimate?: number | null } = {},
  sizes: string[] = JIG_TAXONOMY.sizes,
) {
  const calls: Call[] = [];
  const transport: LinearTransport = async (query, variables) => {
    calls.push({ query, variables });
    const has = (name: string) => query.includes(`${name}(`);
    if (has("TrackerEstimates"))
      return {
        teams: page([
          {
            key: "ENG",
            issueEstimationType: estimates.type,
            issueEstimationAllowZero: estimates.zero ?? false,
            issueEstimationExtended: estimates.extended ?? false,
          },
        ]),
      };
    if (has("TrackerTeam"))
      return { teams: page([{ id: "team-1", key: "ENG" }]) };
    if (has("TrackerLabels")) return { issueLabels: page(LABELS) };
    if (has("TrackerCreate"))
      return {
        issueCreate: {
          success: true,
          issue: { identifier: "ENG-9", url: null },
        },
      };
    const estimate = query.includes("estimate") ? read.estimate : undefined;
    if (has("TrackerPoolIssue")) return { issue: poolNode(estimate) };
    if (has("TrackerPool")) return { issues: page([poolNode(estimate)]) };
    if (has("TrackerIssue")) return { issue: issueNode(estimate) };
    if (has("TrackerIssueId"))
      return { issue: { id: "uuid-1", team: { id: "team-1", key: "ENG" } } };
    if (has("TrackerUpdate")) return { issueUpdate: { success: true } };
    throw new Error(`unexpected ${query.slice(0, 40)}`);
  };
  const config = parseTrackerConfig({
    issue_tracker: { adapter: "linear", team: "ENG", ...section },
  });
  const facets = resolveFacets(facetInputs(config), {
    path: "label-taxonomy.yaml",
    types: JIG_TAXONOMY.types,
    sizes,
  });
  return {
    t: linearTracker({ team: "ENG", states: config.states, transport, facets }),
    calls,
    facets,
  };
}

const ESTIMATE = { facets: { size: { store: "native" } } };

const created = (calls: Call[]) =>
  calls.find((c) => c.query.includes("TrackerCreate("))?.variables.input;
const updated = (calls: Call[]) =>
  calls
    .filter((c) => c.query.includes("TrackerUpdate("))
    .map((c) => c.variables.input);

describe("Linear: size in the estimate", () => {
  it("files and changes a size as the estimate, mapped in order onto the team's scale", async () => {
    const { t, calls } = linear(ESTIMATE);
    await t.createIssue({
      title: "x",
      description: "",
      labels: [],
      type: "bug",
      priority: 2,
      size: "medium",
    });
    expect(created(calls)).toEqual({
      teamId: "team-1",
      title: "x",
      description: "",
      labelIds: ["l-bug"],
      priority: 2,
      estimate: 3,
    });
    await t.updateIssue("ENG-1", { size: "xl" });
    await t.updateIssue("ENG-1", { size: null });
    expect(updated(calls)).toEqual([{ estimate: 8 }, { estimate: null }]);
    expect(
      calls.filter((c) => c.query.includes("TrackerEstimates(")).length,
    ).toBe(1);
  });

  it("reads the size its estimate holds, in every read", async () => {
    const { t, calls } = linear(ESTIMATE, FIBONACCI, { estimate: 5 });
    expect((await t.getIssue("ENG-1"))?.size).toBe("large");
    expect((await t.poolIssue("ENG-1"))?.size).toBe("large");
    const pool = await t.openIssues({ withSomeOf: [["bug"]] });
    expect(pool.map((i) => [i.size, i.unmappedFacets])).toEqual([
      ["large", undefined],
    ]);
    expect((await t.openPopulation()).map((i) => i.size)).toEqual(["large"]);
    const reads = calls.filter((c) => !c.query.includes("TrackerEstimates("));
    expect(reads.every((c) => /priority estimate/.test(c.query))).toBe(true);
  });

  it("reads an estimate no size holds as none, and marks it unmapped", async () => {
    const { t } = linear(ESTIMATE, FIBONACCI, { estimate: 13 });
    const issue = await t.poolIssue("ENG-1");
    expect([issue?.size, issue?.unmappedFacets]).toEqual([null, ["size"]]);
    const none = linear(ESTIMATE, FIBONACCI, { estimate: null });
    expect((await none.t.poolIssue("ENG-1"))?.size).toBeNull();
  });

  it("maps each size to the point values names, a T-shirt name included", async () => {
    const named = {
      facets: {
        size: {
          store: "native",
          values: { xs: 0, small: "S", medium: "M", large: "L", xl: "XL" },
        },
      },
    };
    const { t, calls } = linear(named, { type: "tShirt", zero: true });
    for (const size of ["xs", "small", "xl"])
      await t.updateIssue("ENG-1", { size });
    expect(updated(calls)).toEqual([
      { estimate: 0 },
      { estimate: 2 },
      { estimate: 8 },
    ]);
  });

  it("reads every point a size lists as that size, and writes its first", async () => {
    const listed = {
      facets: {
        size: {
          store: "native",
          values: { xs: 1, small: 2, medium: 3, large: [5, 13], xl: [8, 21] },
        },
      },
    };
    const extended = { type: "fibonacci", extended: true };
    for (const [estimate, size] of [
      [13, "large"],
      [5, "large"],
      [21, "xl"],
    ] as const) {
      const { t } = linear(listed, extended, { estimate });
      expect((await t.getIssue("ENG-1"))?.size).toBe(size);
    }
    const { t, calls } = linear(listed, extended);
    await t.updateIssue("ENG-1", { size: "large" });
    expect(updated(calls)).toEqual([{ estimate: 5 }]);
  });

  it("refuses a native priority that lists several numbers", () => {
    const listed = resolveFacets(
      facetInputs(
        parseTrackerConfig({
          issue_tracker: {
            adapter: "linear",
            team: "ENG",
            facets: {
              priority: { store: "native", values: { urgent: [1, 0] } },
            },
          },
        }),
      ),
      null,
    );
    expect(() => checkLinearFacets(listed)).toThrow(
      "cannot remap Linear's native priority",
    );
  });

  it("refuses, before writing, a team with estimates off, a scale with too few points, and a value off the scale", async () => {
    const refusal = async (
      section: Record<string, unknown>,
      estimates: Estimates,
    ) => {
      const { t, calls } = linear(section, estimates);
      const err = await t
        .createIssue({ title: "x", description: "", labels: [], size: "small" })
        .catch((e: unknown) => (e as Error).message);
      expect(calls.some((c) => c.query.includes("TrackerCreate("))).toBe(false);
      return err;
    };
    expect(await refusal(ESTIMATE, { type: "notUsed" })).toContain(
      "team ENG has estimates off",
    );
    expect(
      await refusal(
        {
          facets: {
            size: {
              store: "native",
              values: { xs: 1, small: 2, medium: 3, large: 5, xl: 34 },
            },
          },
        },
        FIBONACCI,
      ),
    ).toContain(
      "xl is '34', which is no point of team ENG's fibonacci scale (1, 2, 3, 5, 8)",
    );
  });

  it("refuses a scale with fewer points than the sizes, and uses an extended scale's further points", async () => {
    // A sixth size makes a five-point scale too short.
    const SIX = [...JIG_TAXONOMY.sizes, "xxl"];
    const short = linear(ESTIMATE, FIBONACCI, {}, SIX);
    await expect(short.t.updateIssue("ENG-1", { size: "xxl" })).rejects.toThrow(
      "keeps 6 sizes in the estimate, but team ENG's fibonacci scale (1, 2, 3, 5, 8) has fewer points",
    );
    expect(updated(short.calls)).toEqual([]);
    const extended = linear(
      ESTIMATE,
      { type: "fibonacci", extended: true },
      {},
      SIX,
    );
    await extended.t.updateIssue("ENG-1", { size: "xxl" });
    expect(updated(extended.calls)).toEqual([{ estimate: 13 }]);
  });

  it("reports the store's health, failed where estimates are off", async () => {
    const on = await linear(ESTIMATE).t.facetStores();
    expect(on.facets.find((f) => f.facet === "size")?.health).toEqual({
      status: "ok",
    });
    const off = await linear(ESTIMATE, { type: "notUsed" }).t.facetStores();
    expect(off.facets.find((f) => f.facet === "size")?.health).toMatchObject({
      status: "failed",
      error: expect.stringContaining("has estimates off"),
    });
  });

  it("refuses, when the configuration is read, a values map naming some sizes and not others", () => {
    const { facets } = linear({});
    const partial = resolveFacets(
      facetInputs(
        parseTrackerConfig({
          issue_tracker: {
            adapter: "linear",
            team: "ENG",
            facets: { size: { store: "native", values: { xs: 1 } } },
          },
        }),
      ),
      { path: "label-taxonomy.yaml", ...JIG_TAXONOMY },
    );
    expect(() => checkLinearFacets(partial)).toThrow(
      "names the estimate of xs but not of small, medium, large, xl",
    );
    expect(() => checkLinearFacets(facets)).not.toThrow();
  });

  it("reads and files exactly as before where size is kept in labels", async () => {
    const { t, calls } = linear({}, FIBONACCI, { estimate: 5 });
    await t.createIssue({
      title: "x",
      description: "",
      labels: [],
      size: "small",
    });
    expect(created(calls)).toEqual({
      teamId: "team-1",
      title: "x",
      description: "",
      labelIds: ["l-small"],
    });
    expect((await t.poolIssue("ENG-1"))?.size).toBeNull();
    expect(calls.some((c) => c.query.includes("estimate"))).toBe(false);
    expect(
      (await t.facetStores()).facets.find((f) => f.facet === "size")?.health,
    ).toBeUndefined();
  });
});
