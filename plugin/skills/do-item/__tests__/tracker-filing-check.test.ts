import { describe, expect, it } from "bun:test";
import {
  facetInputs,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import {
  checkedTracker,
  incompleteness,
} from "../scripts/lib/tracker/facets/complete.ts";
import { resolveFacets } from "../scripts/lib/tracker/facets/config.ts";
import {
  type NewIssue,
  type Tracker,
  TrackerRequestError,
} from "../scripts/lib/tracker/port.ts";
import { lintTaxonomy } from "../../file-issue/scripts/lib/taxonomy.ts";
import { JIG_TAXONOMY } from "./github-fixtures.ts";

const facets = resolveFacets(
  facetInputs(parseTrackerConfig({ issue_tracker: { adapter: "github" } })),
  { path: "label-taxonomy.yaml", ...JIG_TAXONOMY },
);

/** Jig's size group, and a second required group no epic is spared. */
const taxonomy = lintTaxonomy({
  version: 1,
  types: JIG_TAXONOMY.types.map((id) => ({ id })),
  statuses: [{ id: "triage" }],
  flags: [
    { id: "epic", scope: "container", fires: "roll-up", apply_when: ["x"] },
  ],
  groups: [
    {
      id: "size",
      required: true,
      not_required_on: ["epic"],
      labels: JIG_TAXONOMY.sizes.map((id) => ({ id })),
    },
    { id: "repo", required: true, labels: [{ id: "jig" }] },
  ],
}).taxonomy;

/** A complete issue, changed by `over` and with the facets in `drop` left out. */
const issue = (
  over: Partial<NewIssue>,
  drop: ReadonlyArray<"type" | "priority" | "size"> = [],
): NewIssue => {
  const out: NewIssue = {
    title: "t",
    description: "",
    labels: ["jig"],
    type: "bug",
    priority: 2,
    size: "small",
    ...over,
  };
  for (const f of drop) delete out[f];
  return out;
};

describe("the filing check inside createIssue", () => {
  it("names each facet and required group a new issue lacks, sparing an epic its size", () => {
    expect(taxonomy).not.toBeNull();
    expect(incompleteness(issue({}), facets, taxonomy)).toEqual([]);
    expect(
      incompleteness(
        issue({ priority: 0, labels: [] }, ["type", "size"]),
        facets,
        taxonomy,
      ),
    ).toEqual(["type", "priority", "size", "repo"]);
    expect(
      incompleteness(
        issue({ labels: ["jig", "epic"] }, ["size"]),
        facets,
        taxonomy,
      ),
    ).toEqual([]);
    // The adapter's resolved filing form decides the exemption, not the facet value.
    expect(
      incompleteness(issue({ labels: ["jig"] }, ["size"]), facets, taxonomy, {
        labels: ["jig", "epic"],
        nativeType: null,
      }),
    ).toEqual([]);
    expect(
      incompleteness(
        issue({ labels: ["jig", "epic"] }, ["size"]),
        facets,
        taxonomy,
        { labels: ["jig"], nativeType: "Task" },
      ),
    ).toEqual(["size"]);
    const noTaxonomy = resolveFacets(
      facetInputs(parseTrackerConfig({ issue_tracker: { adapter: "github" } })),
      null,
    );
    expect(
      incompleteness(issue({ labels: [] }, ["size"]), noTaxonomy, null),
    ).toEqual([]);
  });

  it("refuses an incomplete issue before writing it, naming what it lacks", async () => {
    const filed: NewIssue[] = [];
    const inner = {
      createIssue: async (i: NewIssue) => {
        filed.push(i);
        return { identifier: "#7", url: null };
      },
    } as unknown as Tracker;
    const t = checkedTracker(inner, facets, taxonomy);
    const refusal = (i: NewIssue) =>
      t.createIssue(i).then(
        () => null,
        (e: unknown) =>
          e instanceof TrackerRequestError ? `${e.code}: ${e.message}` : e,
      );
    expect(await refusal(issue({}, ["priority"]))).toBe(
      'invalid: refused to file an issue with no priority: every issue is filed with its type, priority and size, so give "type", "priority" (1 to 4) and "size" in the issue tracker.ts create reads (an epic needs no size)',
    );
    expect(await refusal(issue({ labels: [] }, ["size"]))).toBe(
      'invalid: refused to file an issue with no size and no repo label: every issue is filed with its type, priority and size, so give "type", "priority" (1 to 4) and "size" in the issue tracker.ts create reads (an epic needs no size) and a label of each required group of the label taxonomy',
    );
    expect(filed).toEqual([]);
    expect(await t.createIssue(issue({}))).toEqual({
      identifier: "#7",
      url: null,
    });
    expect(await refusal(issue({ labels: ["jig", "epic"] }, ["size"]))).toBe(
      null,
    );
    expect(filed).toHaveLength(2);
  });
});

it("refuses a broken taxonomy slot instead of disabling its required facet", async () => {
  let filed = false;
  const inner = {
    createIssue: async () => {
      filed = true;
      return { identifier: "#1", url: null };
    },
  } as unknown as Tracker;
  const broken = {
    ...facets,
    type: {
      facet: "type" as const,
      store: null,
      why: "invalid taxonomy",
      problem: "type taxonomy failed lint",
    },
  };
  const tracker = checkedTracker(inner, broken, null);
  await expect(
    tracker.createIssue(issue({ priority: 2 }, ["type", "size"])),
  ).rejects.toThrow("taxonomy failed lint");
  expect(filed).toBe(false);
});

it("defers taxonomy refusal until filing and preserves reads", async () => {
  let read = 0;
  const inner = {
    listLabels: async () => {
      read++;
      return [];
    },
  } as unknown as Tracker;
  const t = checkedTracker(inner, facets, () => {
    throw new Error("bad taxonomy");
  });
  expect(await t.listLabels()).toEqual([]);
  expect(read).toBe(1);
  await expect(t.createIssue(issue({}))).rejects.toThrow("bad taxonomy");
});
