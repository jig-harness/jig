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
import type { NewIssue, Tracker } from "../scripts/lib/tracker/port.ts";
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
    const noTaxonomy = resolveFacets(
      facetInputs(parseTrackerConfig({ issue_tracker: { adapter: "github" } })),
      null,
    );
    expect(
      incompleteness(issue({ labels: [] }, ["size"]), noTaxonomy, null),
    ).toEqual([]);
  });

  it("files an incomplete issue, then warns naming it and what it lacks", async () => {
    const filed: NewIssue[] = [];
    const inner = {
      createIssue: async (i: NewIssue) => {
        filed.push(i);
        return { identifier: "#7", url: null };
      },
    } as unknown as Tracker;
    const warnings: string[] = [];
    const t = checkedTracker(inner, facets, taxonomy, (m) => warnings.push(m));
    expect(await t.createIssue(issue({}, ["priority"]))).toEqual({
      identifier: "#7",
      url: null,
    });
    expect(filed).toHaveLength(1);
    expect(warnings).toEqual([
      'warning: #7 was filed without priority; the next release refuses an issue filed without them, so give each when filing (tracker.ts create takes "type", "priority" 1 to 4, and "size")',
    ]);
    await t.createIssue(issue({ labels: [] }));
    expect(warnings.at(-1)).toContain("filed without a repo label");
    await t.createIssue(issue({}));
    expect(warnings).toHaveLength(2);
  });
});
