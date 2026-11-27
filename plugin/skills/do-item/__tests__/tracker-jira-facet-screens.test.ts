import { describe, expect, it } from "bun:test";
import { pacedWriter } from "../../file-issue/scripts/lib/pace.ts";
import { sweep, sweepLines } from "../../file-issue/scripts/lib/sweep.ts";
import { checkedTracker } from "../scripts/lib/tracker/facets/complete.ts";
import { JIG_TAXONOMY } from "./github-fixtures.ts";
import { TYPES } from "./jira-facet-fixtures.ts";
import {
  type Call,
  issue,
  jira,
  type Overlay,
  page,
  routes,
  writes,
} from "./jira-fixtures.ts";

/** The site's fields, its issue types and its priorities. */
const SITE = {
  "GET field": [
    {
      id: "customfield_10016",
      name: "Story Points",
      schema: { type: "number" },
    },
  ],
  "GET issue/createmeta/ENG/issuetypes": TYPES,
  "GET priority/search": {
    values: ["Highest", "High", "Medium", "Low"].map((name, i) => ({
      id: String(i + 1),
      name,
    })),
    startAt: 0,
    maxResults: 100,
    isLast: true,
  },
  "POST search/jql": page(),
};

const filed = (calls: Call[]) =>
  calls.find((c) => c.route === "POST issue")?.body.fields as Record<
    string,
    unknown
  >;

describe("Jira: a facet field missing from an issue type's screen", () => {
  /** A create screen holding the Story Points field. */
  const POINTS = {
    fields: [{ fieldId: "customfield_10016" }, { fieldId: "priority" }],
    startAt: 0,
    maxResults: 100,
    total: 2,
  };
  /** A create screen without it. */
  const BARE = {
    fields: [{ fieldId: "priority" }],
    startAt: 0,
    maxResults: 100,
    total: 1,
  };
  /** Size in the Story Points number field, type in the issue types. */
  const POINTED = (
    jira: Record<string, unknown> = {},
    epicTypes: string[] = [],
    typeValues: Record<string, string> = { feature: "Story" },
  ): Overlay => ({
    issue_tracker: {
      states: { todo: "To Do" },
      jira,
      ...(epicTypes.length === 0 ? {} : { labels: { epic_types: epicTypes } }),
      facets: {
        type: { store: "native", values: typeValues },
        size: {
          store: "field",
          field: "Story Points",
          values: { xs: 1, small: 2, medium: 3, large: 5, xl: 8 },
        },
      },
    },
    taxonomy: JIG_TAXONOMY,
  });
  /** Every create screen holds Story Points but those `lacking` names (by id). */
  const site = (...lacking: string[]) => ({
    ...SITE,
    ...Object.fromEntries(
      ["t0", "t1", "t2", "t3", "t4"].map((id) => [
        `GET issue/createmeta/ENG/issuetypes/${id}`,
        lacking.includes(id) ? BARE : POINTS,
      ]),
    ),
  });
  const file = (t: Awaited<ReturnType<typeof jira>>["t"], more = {}) =>
    t.createIssue({
      title: "T",
      description: "",
      labels: [],
      type: "bug",
      priority: 3,
      size: "small",
      ...more,
    });

  it("refuses, before writing, a bug or a sub-task whose create screen lacks the size's number field", async () => {
    const { t, calls } = jira(
      routes({
        ...site("t1", "t4"),
        "GET issue/ENG-2": issue({ key: "ENG-2", type: "Task" }),
        "POST issue": { id: "1", key: "ENG-9" },
      }),
      POINTED(),
    );
    await expect(file(t)).rejects.toThrow(
      "size is kept in the field 'Story Points' (customfield_10016), which is not on the create screen of Bug in ENG; add it to the screen, or keep size in labels (store: label)",
    );
    await expect(file(t, { parent: "ENG-2" })).rejects.toThrow(
      "size is kept in the field 'Story Points' (customfield_10016), which is not on the create screen of Sub-task in ENG",
    );
    expect(writes(calls)).toEqual([]);
    await file(t, { type: "docs" });
    expect(filed(calls)).toMatchObject({
      issuetype: { name: "Task" },
      customfield_10016: 2,
    });
  });

  it("files without a size only when the issue type's create screen lacks its field", async () => {
    const { t, calls, client } = jira(
      routes({
        ...site("t1"),
        "POST issue": { id: "1", key: "ENG-9" },
      }),
      POINTED(),
    );
    const tracker = checkedTracker(t, client.facets, null);
    await expect(
      file(tracker, { type: "docs", size: undefined }),
    ).rejects.toThrow("no size");
    expect(writes(calls)).toEqual([]);
    await expect(file(tracker, { size: undefined })).resolves.toMatchObject({
      identifier: "ENG-9",
    });
    expect(filed(calls)).toHaveProperty("issuetype", { name: "Bug" });
    expect(filed(calls)).not.toHaveProperty("customfield_10016");
  });

  it("sweeps only the issues whose screens can hold a missing size", async () => {
    const { t, calls } = jira(
      routes({
        ...site("t1"),
        "POST search/jql": page(
          issue({ key: "ENG-1", type: "Bug" }),
          issue({
            key: "ENG-2",
            labels: ["docs"],
            fields: { customfield_10016: null },
          }),
          issue({
            key: "ENG-3",
            labels: ["docs"],
            fields: { customfield_10016: 2 },
          }),
          issue({ key: "ENG-4", type: "Bug" }),
          issue({
            key: "ENG-5",
            labels: ["docs"],
            fields: { customfield_10016: 2 },
          }),
        ),
        "GET issue/ENG-1/editmeta": { fields: { summary: {} } },
        "GET issue/ENG-4/editmeta": {
          fields: { summary: {}, customfield_10016: {} },
        },
      }),
      POINTED(),
    );
    const report = await sweep(t, {
      apply: false,
      retired: () => [],
      writer: pacedWriter(),
    });
    expect(report.storeProblem).toBeNull();
    expect(report.listed.map((i) => [i.identifier, i.missing])).toEqual([
      ["ENG-2", ["size"]],
      ["ENG-4", ["size"]],
    ]);
    expect(report.storeProblem).toBeNull();
    expect(sweepLines(report)).toContain(
      "size: passed over 1 open issue(s) whose Jira screens lack the field",
    );
    expect(calls.filter((c) => c.route.endsWith("/editmeta"))).toHaveLength(2);
  });

  it("fails the census rather than exempt a facet from a permission-filtered edit screen", async () => {
    const { t } = jira(
      routes({
        ...site("t1"),
        "POST search/jql": page(issue({ key: "ENG-1", type: "Bug" })),
        "GET issue/ENG-1/editmeta": { fields: {} },
      }),
      POINTED(),
    );
    await expect(
      sweep(t, { apply: false, retired: () => [], writer: pacedWriter() }),
    ).rejects.toThrow("lists no summary");
  });

  it("refuses to set or clear a size whose field is not on the issue's edit screen, naming its issue type", async () => {
    const { t, calls } = jira(
      routes({
        ...site(),
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          type: "Bug",
          fields: { customfield_10016: 2 },
        }),
        "GET issue/ENG-1/editmeta": { fields: {} },
        "PUT issue/ENG-1": null,
      }),
      POINTED(),
    );
    for (const size of ["large", null])
      await expect(t.updateIssue("ENG-1", { size })).rejects.toThrow(
        "size is kept in the field 'Story Points' (customfield_10016), which is not on the edit screen of ENG-1 (Bug); add it to the screen, or keep size in labels (store: label)",
      );
    expect(writes(calls)).toEqual([]);
  });

  it("reports every issue type Jig files whose create screen lacks the field, and nothing when each has it", async () => {
    const health = async (
      lacking: string[],
      settings = {},
      epicTypes: string[] = [],
      typeValues?: Record<string, string>,
    ) => {
      const { t } = jira(
        routes(site(...lacking)),
        POINTED(settings, epicTypes, typeValues),
      );
      return (await t.facetStores()).facets.find((f) => f.facet === "size")
        ?.health;
    };
    expect(await health([])).toEqual({ status: "ok" });
    expect(await health(["t1", "t4"])).toEqual({
      status: "failed",
      unavailable: false,
      error:
        "size is kept in the field 'Story Points' (customfield_10016), which is not on the create screens of Sub-task and Bug in ENG; add it to those screens, or keep size in labels (store: label)",
      fails: "filing a Sub-task or a Bug with the facet set fails",
    });
    // An epic type is asked no size, so its screen may lack the field.
    expect(
      await health(["t0"], { pool_issue_types: ["Task", "Epic"] }, ["Epic"]),
    ).toEqual({ status: "ok" });
    // A type value with no issue type is the type facet's finding, not size's.
    expect(await health([], {}, [], { feature: "Storyy" })).toEqual({
      status: "ok",
    });
    // The pool's issue types are filed too; an unlisted type is not asked about.
    expect(
      await health(["t0"], { pool_issue_types: ["Task", "Epic", "Spike"] }),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("not on the create screen of Epic in ENG"),
      fails: "filing an Epic with the facet set fails",
    });
  });

  it("judges a mapping no screen can satisfy before the screens, so a screen gap does not hide it", async () => {
    // small is kept as a word, which a number field cannot take.
    const shared: Overlay = POINTED();
    const facets = (
      shared.issue_tracker as { facets: { size: { values: unknown } } }
    ).facets;
    facets.size.values = { xs: 1, small: "two", medium: 3, large: 5, xl: 8 };
    const { t } = jira(routes(site("t4")), shared);
    const health = (await t.facetStores()).facets.find(
      (f) => f.facet === "size",
    )?.health;
    expect(health).toMatchObject({
      status: "failed",
      error: expect.stringContaining("is kept as 'two' in the number field"),
    });
    expect(health).not.toHaveProperty("fails");
  });

  it("reports a create screen that offers fewer options as a filing-only failure", async () => {
    const options: Overlay = {
      issue_tracker: {
        facets: {
          type: { store: "native", values: { feature: "Story" } },
          size: {
            store: "field",
            field: "Size",
            values: {
              xs: "XS",
              small: "Small",
              medium: "Medium",
              large: "Large",
              xl: "XL",
            },
          },
        },
      },
      taxonomy: JIG_TAXONOMY,
    };
    const screen = (names: string[]) => ({
      fields: [
        {
          fieldId: "customfield_10020",
          allowedValues: names.map((value) => ({ value })),
        },
      ],
      startAt: 0,
      maxResults: 100,
      total: 1,
    });
    const all = screen(["XS", "Small", "Medium", "Large", "XL"]);
    const healthOf = async (screens: Record<string, unknown>) => {
      const { t } = jira(
        routes({
          ...SITE,
          "GET field": [
            {
              id: "customfield_10020",
              name: "Size",
              schema: { type: "option" },
            },
          ],
          ...Object.fromEntries(
            ["t0", "t1", "t2", "t3", "t4"].map((id) => [
              `GET issue/createmeta/ENG/issuetypes/${id}`,
              screens[id] ?? all,
            ]),
          ),
        }),
        options,
      );
      return (await t.facetStores()).facets.find((f) => f.facet === "size")
        ?.health;
    };
    const health = await healthOf({ t4: screen(["Small", "Medium"]) });
    expect(health).toMatchObject({
      status: "failed",
      unavailable: false,
      error: expect.stringContaining("which has Small, Medium"),
      fails: "filing a Sub-task with the facet set fails",
    });
    // A screen without the field does not hide the restricted screens.
    expect(
      await healthOf({
        t1: { fields: [], startAt: 0, maxResults: 100, total: 0 },
        t4: screen(["Small", "Medium"]),
      }),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("not on the create screen of Bug"),
      fails: "filing a Bug or a Sub-task with the facet set fails",
    });
  });
});
