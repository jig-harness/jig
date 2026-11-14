import { describe, expect, it } from "bun:test";
import {
  facetInputs,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import { TrackerConfigError } from "../scripts/lib/tracker/config-error.ts";
import {
  resolveFacets,
  type ResolvedFacet,
} from "../scripts/lib/tracker/facets/config.ts";
import { checkJiraFacets } from "../scripts/lib/tracker/jira/facets.ts";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import { httpFailure } from "../scripts/lib/tracker/jira/transport.ts";
import { JIG_TAXONOMY } from "./github-fixtures.ts";
import {
  type Call,
  issue,
  jira,
  type Overlay,
  page,
  routes,
  writes,
} from "./jira-fixtures.ts";

/** The site's fields, as `GET field` returns them. */
const SITE_FIELDS = [
  { id: "summary", name: "Summary", schema: { type: "string" } },
  { id: "customfield_10016", name: "Story Points", schema: { type: "number" } },
  { id: "customfield_10050", name: "Size", schema: { type: "option" } },
  { id: "customfield_10051", name: "Team", schema: { type: "option" } },
  { id: "customfield_10052", name: "Team", schema: { type: "option" } },
  {
    id: "customfield_10060",
    name: "Notes",
    schema: {
      type: "string",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
    },
  },
];

/** The project's issue types, as `GET issue/createmeta/ENG/issuetypes` returns them. */
const TYPES = {
  issueTypes: [
    ["t0", "Epic", false, 1],
    ["t1", "Bug", false, 0],
    ["t2", "Story", false, 0],
    ["t3", "Task", false, 0],
    ["t4", "Sub-task", true, -1],
  ].map(([id, name, subtask, hierarchyLevel]) => ({
    id,
    name,
    subtask,
    hierarchyLevel,
  })),
  startAt: 0,
  maxResults: 100,
  total: 5,
};

const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL"].map((value, i) => ({
  id: `o${i}`,
  value,
}));

/** A create screen holding the Size field with its options. */
const SCREEN = {
  fields: [
    { fieldId: "customfield_10050", allowedValues: SIZE_OPTIONS },
    {
      fieldId: "priority",
      allowedValues: ["Highest", "High", "Medium", "Low"].map((name, i) => ({
        id: String(i + 1),
        name,
      })),
    },
  ],
  startAt: 0,
  maxResults: 100,
  isLast: true,
};

const PRIORITIES = {
  values: ["Highest", "High", "Medium", "Low"].map((name, i) => ({
    id: String(i + 1),
    name,
  })),
  startAt: 0,
  maxResults: 100,
  isLast: true,
};

/** Type in the issue types (feature is a Story), size in the Size field. */
const STORES: Overlay = {
  issue_tracker: {
    facets: {
      type: { store: "native", values: { feature: "Story" } },
      size: {
        store: "field",
        field: "Size",
        values: { xs: "XS", small: "S", medium: "M", large: "L", xl: "XL" },
      },
    },
  },
  taxonomy: JIG_TAXONOMY,
};

/** Every create screen and the site's lists the stores read. */
const SITE = {
  "GET field": SITE_FIELDS,
  "GET issue/createmeta/ENG/issuetypes": TYPES,
  "GET issue/createmeta/ENG/issuetypes/t1": SCREEN,
  "GET issue/createmeta/ENG/issuetypes/t2": SCREEN,
  "GET issue/createmeta/ENG/issuetypes/t3": SCREEN,
  "GET issue/createmeta/ENG/issuetypes/t4": SCREEN,
  "GET priority/search": PRIORITIES,
  "POST search/jql": page(),
};

const filed = (calls: Call[]) =>
  calls.find((c) => c.route === "POST issue")?.body.fields as Record<
    string,
    unknown
  >;

describe("Jira: type in the issue types and size in a custom field", () => {
  it("files a bug of size medium as a Bug with its Size set, and reads it back as both", async () => {
    let created: Record<string, unknown> = {};
    const { t, calls } = jira(
      routes({
        ...SITE,
        "POST issue": (c: Call) => {
          created = c.body.fields as Record<string, unknown>;
          return { id: "10001", key: "ENG-1" };
        },
        // The issue as Jira holds it after the create: its issue type and its field.
        "GET issue/ENG-1": () =>
          issue({
            key: "ENG-1",
            type: (created.issuetype as { name: string }).name,
            priority: "High",
            labels: (created.labels as string[] | undefined) ?? [],
            fields: { customfield_10050: created.customfield_10050 },
          }),
      }),
      STORES,
    );
    await t.createIssue({
      title: "Crash",
      description: "",
      labels: ["area:api"],
      type: "bug",
      priority: 2,
      size: "medium",
    });
    const fields = filed(calls);
    expect(fields.issuetype).toEqual({ name: "Bug" });
    expect(fields.customfield_10050).toEqual({ value: "M" });
    expect(fields.labels).toEqual(["area:api"]);
    const read = await t.getIssue("ENG-1");
    expect([read?.type, read?.size, read?.priority, read?.labels]).toEqual([
      "bug",
      "medium",
      2,
      ["area:api"],
    ]);
    const asked = calls.find((c) => c.route === "GET issue/ENG-1");
    expect(String(asked?.query.fields).split(",")).toContain(
      "customfield_10050",
    );
    expect((await t.poolIssue("ENG-1"))?.size).toBe("medium");
  });

  it("files a mapped type as its issue type, and a type with no issue type of its name as issue_type with its label", async () => {
    const { t, calls } = jira(
      routes({ ...SITE, "POST issue": { id: "1", key: "ENG-1" } }),
      STORES,
    );
    const file = async (type: string) => {
      await t.createIssue({
        title: "T",
        description: "",
        labels: [],
        type,
        priority: 3,
        size: "small",
      });
      const fields = calls.filter((c) => c.route === "POST issue").at(-1)?.body
        .fields as Record<string, unknown>;
      return [fields.issuetype, fields.labels];
    };
    expect(await file("feature")).toEqual([{ name: "Story" }, undefined]);
    expect(await file("docs")).toEqual([{ name: "Task" }, ["docs"]]);
  });

  it("keeps the type in its label under a parent: a sub-task under a standard issue, issue_type under an Epic", async () => {
    const under = async (parent: Record<string, unknown>) => {
      const { t, calls } = jira(
        routes({
          ...SITE,
          "GET issue/ENG-2": parent,
          "POST issue": { id: "1", key: "ENG-9" },
        }),
        STORES,
      );
      await t.createIssue({
        title: "T",
        description: "",
        labels: [],
        type: "bug",
        priority: 3,
        size: "small",
        parent: "ENG-2",
      });
      const fields = filed(calls);
      return [fields.issuetype, fields.labels];
    };
    expect(await under(issue({ key: "ENG-2", type: "Task" }))).toEqual([
      { name: "Sub-task" },
      ["bug"],
    ]);
    expect(
      await under(issue({ key: "ENG-2", type: "Epic", typeLevel: 1 })),
    ).toEqual([{ name: "Task" }, ["bug"]]);
  });

  it("refuses, before writing, a mapped issue type the project lacks and an option the field lacks", async () => {
    const { t, calls } = jira(routes(SITE), {
      ...STORES,
      issue_tracker: {
        facets: {
          type: { store: "native", values: { feature: "Feature" } },
          size: {
            store: "field",
            field: "customfield_10050",
            values: {
              xs: "Tiny",
              small: "S",
              medium: "M",
              large: "L",
              xl: "XL",
            },
          },
        },
      },
    });
    const file = (type: string, size: string) =>
      t.createIssue({
        title: "T",
        description: "",
        labels: [],
        type,
        priority: 3,
        size,
      });
    await expect(file("feature", "small")).rejects.toThrow(
      "type feature is kept in Jira's issue types as 'Feature', which is no standard issue type of ENG (it has: Bug, Story, Task)",
    );
    await expect(file("bug", "xs")).rejects.toThrow(
      "size xs is kept as the option 'Tiny' of the field 'Size', which has XS, S, M, L, XL",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("refuses a type label among a new issue's labels, pointing at the type", async () => {
    const { t, calls } = jira(routes(SITE), STORES);
    await expect(
      t.createIssue({ title: "T", description: "", labels: ["docs"] }),
    ).rejects.toThrow(
      "the label 'docs' to file is the type docs; give it as the issue's type (type: docs), not as a label",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a size label among a new issue's labels where the size field keeps no field_labels", async () => {
    const { t, calls } = jira(routes(SITE), STORES);
    await expect(
      t.createIssue({ title: "T", description: "", labels: ["small"] }),
    ).rejects.toThrow(
      "the label 'small' stands for the size small, which this repository keeps in the field 'Size', not in labels",
    );
    expect(calls).toEqual([]);
  });
});

describe("Jira: reading a type kept in the issue types", () => {
  const read = async (opts: {
    type: string;
    labels?: string[];
    subtask?: boolean;
  }) => {
    const { t } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          type: opts.type,
          labels: opts.labels ?? [],
          subtask: opts.subtask ?? false,
          fields: { customfield_10050: null },
        }),
      }),
      STORES,
    );
    const pool = await t.poolIssue("ENG-1");
    return [pool?.type, pool?.unmappedFacets ?? []];
  };

  it("lets a type label win over the fallback issue type, and reads any other two values as none", async () => {
    expect(await read({ type: "Story" })).toEqual(["feature", []]);
    expect(await read({ type: "Task", labels: ["docs"] })).toEqual([
      "docs",
      [],
    ]);
    expect(
      await read({ type: "Sub-task", subtask: true, labels: ["bug"] }),
    ).toEqual(["bug", []]);
    expect(await read({ type: "Bug", labels: ["docs"] })).toEqual([null, []]);
    expect(await read({ type: "Bug", labels: ["bug"] })).toEqual(["bug", []]);
    expect(await read({ type: "Task", labels: ["bug", "docs"] })).toEqual([
      null,
      [],
    ]);
  });

  it("lets a type label win over issue_type where issue_type is itself a type's issue type", async () => {
    const typed = async (labels: string[], type = "Task") => {
      const { t } = jira(
        routes({
          ...SITE,
          "GET issue/ENG-1": issue({ key: "ENG-1", type, labels }),
        }),
        {
          issue_tracker: {
            facets: {
              type: { store: "native", values: { chore: "Task" } },
            },
          },
          taxonomy: JIG_TAXONOMY,
        },
      );
      return (await t.getIssue("ENG-1"))?.type;
    };
    expect(await typed([])).toBe("chore");
    expect(await typed(["docs"])).toBe("docs");
    expect(await typed(["docs"], "Bug")).toBeNull();
  });

  it("reads an issue type no type is kept as as none, and marks it unmapped", async () => {
    expect(await read({ type: "Incident" })).toEqual([null, ["type"]]);
    expect(await read({ type: "Task" })).toEqual([null, []]);
  });

  it("reads an unmapped issue type as none even beside a type label", async () => {
    expect(await read({ type: "Incident", labels: ["bug"] })).toEqual([
      null,
      ["type"],
    ]);
  });
});

/** The issue types the edit screen offers an issue of one workflow. */
const EDIT_TYPES = {
  allowedValues: [
    { id: "t1", name: "Bug" },
    { id: "t2", name: "Story" },
    { id: "t3", name: "Task" },
  ],
};

describe("Jira: changing a type and a size kept in Jira's own fields", () => {
  const change = async (
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": current,
        "GET issue/ENG-1/editmeta": {
          fields: {
            customfield_10050: { allowedValues: SIZE_OPTIONS },
            issuetype: EDIT_TYPES,
          },
        },
        "PUT issue/ENG-1": null,
        ...extra,
      }),
      STORES,
    );
    await t.updateIssue("ENG-1", patch);
    return calls
      .filter((c) => c.route === "PUT issue/ENG-1")
      .map((c) => c.body);
  };

  it("moves a type to its issue type and takes its labels off, in one write", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Task", labels: ["docs"] }), {
        type: "bug",
      }),
    ).toEqual([
      {
        fields: { issuetype: { id: "t1" } },
        update: { labels: [{ remove: "docs" }] },
      },
    ]);
  });

  it("gives a type with no issue type of its own the fallback issue type and its label", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Bug" }), { type: "chore" }),
    ).toEqual([
      {
        fields: { issuetype: { id: "t3" } },
        update: { labels: [{ add: "chore" }] },
      },
    ]);
    expect(
      await change(issue({ key: "ENG-1", type: "Task", labels: ["docs"] }), {
        type: "chore",
      }),
    ).toEqual([{ update: { labels: [{ add: "chore" }, { remove: "docs" }] } }]);
  });

  it("changes the issue type the edit screen offers", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Task" }), { type: "feature" }),
    ).toEqual([{ fields: { issuetype: { id: "t2" } } }]);
  });

  /** A type change on an issue whose edit screen offers `issuetype` as given, with every call made. */
  const across = async (
    issuetype: Record<string, unknown> | undefined,
    patch: Record<string, unknown>,
    current = issue({ key: "ENG-1", type: "Task" }),
  ) => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": current,
        "GET issue/ENG-1/editmeta": {
          fields: {
            customfield_10050: { allowedValues: SIZE_OPTIONS },
            ...(issuetype === undefined ? {} : { issuetype }),
          },
        },
        "PUT issue/ENG-1": null,
      }),
      STORES,
    );
    const err = await t.updateIssue("ENG-1", patch).catch((e: unknown) => e);
    return { err, calls };
  };

  it("refuses, before any write, a type change the edit screen offers no issue type field for", async () => {
    const { err, calls } = await across(undefined, { type: "feature" });
    expect(err).toBeInstanceOf(TrackerRequestError);
    expect((err as Error).message).toBe(
      "type feature is kept in Jira's issue types as 'Story', but the edit screen of ENG-1 lets its issue type change from Task to no other type: Jira changes an issue type by an edit only between issue types of one workflow and field configuration; move ENG-1 to Story in Jira, or keep type in labels or a field (store: label or store: field)",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("refuses, before any write, a type change to an issue type the edit screen does not offer", async () => {
    const { err, calls } = await across(
      {
        allowedValues: [
          { id: "t1", name: "Bug" },
          { id: "t3", name: "Task" },
        ],
      },
      { type: "feature" },
    );
    expect((err as Error).message).toContain(
      "the edit screen of ENG-1 lets its issue type change from Task to Bug only: Jira changes",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("refuses moving to the fallback issue type the edit screen does not offer", async () => {
    const { err, calls } = await across(
      {
        allowedValues: [
          { id: "t1", name: "Bug" },
          { id: "t2", name: "Story" },
        ],
      },
      { type: "chore" },
      issue({ key: "ENG-1", type: "Story" }),
    );
    expect((err as Error).message).toContain(
      "type chore is kept in the label 'chore' on the issue type Task, but the edit screen of ENG-1 lets its issue type change from Story to Bug only",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("asks the edit screen once when a write changes both the type and the size", async () => {
    const { err, calls } = await across(EDIT_TYPES, {
      type: "feature",
      size: "large",
    });
    expect(err).toBeUndefined();
    expect(
      calls.filter((c) => c.route === "GET issue/ENG-1/editmeta"),
    ).toHaveLength(1);
    expect(
      calls.filter((c) => c.route === "PUT issue/ENG-1").map((c) => c.body),
    ).toEqual([
      {
        fields: {
          issuetype: { id: "t2" },
          customfield_10050: { value: "L" },
        },
      },
    ]);
  });

  it("writes nothing for a type already in force", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Story" }), { type: "feature" }),
    ).toEqual([]);
  });

  it("refuses to remove a type the issue type holds", async () => {
    await expect(
      change(issue({ key: "ENG-1", type: "Bug" }), { type: null }),
    ).rejects.toThrow(
      "a Jira issue always has an issue type, and ENG-1's is Bug, the type bug",
    );
  });

  it("refuses to remove the label of the type the write sets", async () => {
    await expect(
      change(
        issue({
          key: "ENG-1",
          type: "Sub-task",
          subtask: true,
          labels: ["bug"],
        }),
        {
          type: "bug",
          removeLabels: ["bug"],
        },
      ),
    ).rejects.toThrow("the label 'bug' to remove is the type 'bug'");
  });

  it("lets a write remove a label the type it sets no longer needs", async () => {
    const writes = await change(
      issue({ key: "ENG-1", type: "Task", labels: ["bug"] }),
      { type: "bug", removeLabels: ["bug"] },
    );
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0])).toContain('"remove":"bug"');
  });

  it("sets and clears the size field, its option checked against the edit screen", async () => {
    const current = issue({
      key: "ENG-1",
      fields: { customfield_10050: { value: "S" } },
    });
    expect(await change(current, { size: "large" })).toEqual([
      { fields: { customfield_10050: { value: "L" } } },
    ]);
    expect(await change(current, { size: null })).toEqual([
      { fields: { customfield_10050: null } },
    ]);
    await expect(
      change(
        current,
        { size: "large" },
        {
          "GET issue/ENG-1/editmeta": {
            fields: {
              customfield_10050: {
                allowedValues: [{ value: "S" }, { value: "M" }],
              },
            },
          },
        },
      ),
    ).rejects.toThrow("which has S, M");
  });
});

describe("Jira: a custom field named by name or id", () => {
  const facets = (section: Record<string, unknown>) =>
    resolveFacets(
      facetInputs(
        parseTrackerConfig({
          issue_tracker: {
            adapter: "jira",
            team: "ENG",
            jira: {
              site: "https://x.atlassian.net",
              ...(section.jira as object),
            },
            ...section,
          },
        }),
      ),
      { path: "label-taxonomy.yaml", ...JIG_TAXONOMY },
    );

  it("refuses a name two fields share, naming both ids", async () => {
    const { t } = jira(routes(SITE), {
      ...STORES,
      issue_tracker: { facets: { size: { store: "field", field: "team" } } },
    });
    const err = await t.getIssue("ENG-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerConfigError);
    expect((err as Error).message).toContain(
      "'team' is the name of 2 fields of the site (customfield_10051, customfield_10052); name the field by its id",
    );
  });

  it("refuses a field that holds rich text, and one field for two facets", async () => {
    const { t } = jira(routes(SITE), {
      ...STORES,
      issue_tracker: { facets: { size: { store: "field", field: "Notes" } } },
    });
    await expect(t.getIssue("ENG-1")).rejects.toThrow("rich text");
    expect(() =>
      checkJiraFacets(
        facets({
          facets: {
            type: { store: "field", field: "Size" },
            size: { store: "field", field: "size" },
          },
        }),
      ),
    ).toThrow("one field cannot hold two facets");
  });

  it("writes a number field's number and reads it back, however Jira spells it", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "POST issue": { id: "1", key: "ENG-1" },
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          fields: { customfield_10016: 5.0 },
        }),
      }),
      {
        ...STORES,
        issue_tracker: {
          facets: {
            size: {
              store: "field",
              field: "customfield_10016",
              values: { xs: 1, small: 2, medium: 3, large: "5.0", xl: 8 },
            },
          },
        },
      },
    );
    await t.createIssue({
      title: "T",
      description: "",
      labels: [],
      type: "bug",
      priority: 3,
      size: "medium",
    });
    expect(filed(calls).customfield_10016).toBe(3);
    expect((await t.getIssue("ENG-1"))?.size).toBe("large");
  });

  it("reports each named store's health", async () => {
    const healthy = jira(routes(SITE), STORES).t;
    expect(
      (await healthy.facetStores()).facets.map((f) => [f.facet, f.health]),
    ).toEqual([
      ["type", { status: "ok" }],
      ["priority", { status: "ok" }],
      ["size", { status: "ok" }],
    ]);
    const broken = jira(routes(SITE), {
      ...STORES,
      issue_tracker: {
        facets: { type: { store: "native", values: { feature: "Feature" } } },
      },
    }).t;
    const type = (await broken.facetStores()).facets[0];
    expect(type?.health).toMatchObject({ status: "failed" });
    expect(type?.values?.feature).toBe("Feature");
  });

  it("reads nothing more for a repository that names no store", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": issue({ key: "ENG-1", labels: ["bug", "small"] }),
        "POST search/jql": page(),
        "POST issue": { id: "1", key: "ENG-2" },
      }),
      { taxonomy: JIG_TAXONOMY },
    );
    const read = await t.getIssue("ENG-1");
    expect([read?.type, read?.size]).toEqual(["bug", "small"]);
    await t.createIssue({
      title: "T",
      description: "",
      labels: [],
      type: "docs",
      size: "large",
    });
    expect(calls.map((c) => c.route)).toEqual([
      "GET myself",
      "GET issue/ENG-1",
      "POST search/jql",
      "POST issue",
    ]);
    expect(filed(calls)).toMatchObject({
      issuetype: { name: "Task" },
      labels: ["docs", "large"],
    });
    const stores = (await t.facetStores()).facets;
    expect(stores.filter((f) => f.facet !== "priority")).toSatisfy(
      (rest: typeof stores) => rest.every((f) => f.health === undefined),
    );
    expect(stores.find((f) => f.facet === "priority")?.health).toEqual({
      status: "ok",
    });
  });
});

describe("Jira: a native priority store", () => {
  const scopeRefused = () =>
    httpFailure(
      401,
      new Headers(),
      '{"code":401,"message":"Unauthorized; scope does not match"}',
      "GET priority/search",
    );
  const LIST = PRIORITIES.values;
  const health = async (table: Record<string, unknown>, overlay = STORES) =>
    (await jira(routes({ ...SITE, ...table }), overlay).t.facetStores()).facets
      .filter((f) => f.facet === "priority")
      .map((f) => f.health);

  it("reads the priorities from GET priority where priority/search is refused for its scope", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET priority/search": scopeRefused(),
        "GET priority": LIST,
        "POST issue": { id: "1", key: "ENG-1" },
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "PUT issue/ENG-1": null,
      }),
      STORES,
    );
    await t.createIssue({
      title: "T",
      description: "",
      labels: [],
      type: "bug",
      priority: 3,
      size: "medium",
    });
    expect(filed(calls).priority).toEqual({ id: "3" });
    await t.updateIssue("ENG-1", { priority: 1 });
    expect(calls.at(-1)?.body).toEqual({ fields: { priority: { id: "1" } } });
  });

  it("does not hide a refusal of the fallback behind the first", async () => {
    const { t } = jira(
      routes({
        ...SITE,
        "GET priority/search": scopeRefused(),
        "GET priority": httpFailure(401, new Headers(), "no", "GET priority"),
      }),
      STORES,
    );
    const err = await t
      .createIssue({
        title: "T",
        description: "",
        labels: [],
        type: "bug",
        priority: 3,
        size: "medium",
      })
      .catch((e: unknown) => e);
    expect(String(err)).toContain("on GET priority:");
  });

  it("reports the store healthy when search is refused and the list answers", async () => {
    expect(
      await health({
        "GET priority/search": scopeRefused(),
        "GET priority": LIST,
      }),
    ).toEqual([{ status: "ok" }]);
  });

  it("reports a priority name the site does not have, naming it", async () => {
    const [h] = await health({
      "GET priority/search": { ...PRIORITIES, values: LIST.slice(1) },
    });
    expect(h).toMatchObject({ status: "failed" });
    expect(JSON.stringify(h)).toContain("priority 'Highest'");
  });

  it("reports a listed alternative name the site does not have, though the written name exists", async () => {
    const [h] = await health(
      {},
      {
        ...STORES,
        issue_tracker: {
          ...STORES.issue_tracker,
          jira: { priorities: { urgent: ["Highest", "Missing"] } },
        },
      },
    );
    expect(h).toMatchObject({ status: "failed" });
    expect(JSON.stringify(h)).toContain("priority 'Missing'");
  });

  it("reports a create screen without the priority field, naming the screen of the issue type a native type files", async () => {
    const [h] = await health({
      "GET issue/createmeta/ENG/issuetypes/t1": {
        ...SCREEN,
        fields: SCREEN.fields.slice(0, 1),
      },
    });
    expect(h).toMatchObject({ status: "failed" });
    expect(JSON.stringify(h)).toContain(
      "priority field is not on the create screen of Bug",
    );
  });

  it("asks priority/search once after the gateway refuses it", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET priority/search": scopeRefused(),
        "GET priority": LIST,
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "PUT issue/ENG-1": null,
      }),
      STORES,
    );
    await t.updateIssue("ENG-1", { priority: 1 });
    await t.updateIssue("ENG-1", { priority: 2 });
    expect(calls.filter((c) => c.route === "GET priority/search")).toHaveLength(
      1,
    );
  });

  it("reports an issue_type the project lacks", async () => {
    const [h] = await health(
      {},
      {
        ...STORES,
        issue_tracker: {
          ...STORES.issue_tracker,
          jira: { issue_type: "Chore" },
        },
      },
    );
    expect(h).toMatchObject({ status: "failed" });
    expect(JSON.stringify(h)).toContain("'Chore' is no issue type of ENG");
  });

  it("reports a priority the create screen does not allow", async () => {
    const narrow = {
      ...SCREEN,
      fields: [
        SCREEN.fields[0],
        {
          fieldId: "priority",
          allowedValues: [{ id: "2", name: "High" }],
        },
      ],
    };
    const [h] = await health({
      "GET issue/createmeta/ENG/issuetypes/t1": narrow,
      "GET issue/createmeta/ENG/issuetypes/t2": narrow,
      "GET issue/createmeta/ENG/issuetypes/t3": narrow,
      "GET issue/createmeta/ENG/issuetypes/t4": narrow,
    });
    expect(h).toMatchObject({ status: "failed" });
    expect(JSON.stringify(h)).toContain(
      "priority 'Highest' is not among the values",
    );
  });
});

describe("Jira: issue_tracker.jira.field_labels as a facet's field", () => {
  /** A taxonomy whose sizes are the labels a Size field gives behind `size:`. */
  const SIZES = {
    types: JIG_TAXONOMY.types,
    sizes: ["size:S", "size:M", "size:L"],
  };
  const OVERLAY: Overlay = {
    issue_tracker: { jira: { field_labels: { Size: "size:" } } },
    taxonomy: SIZES,
  };

  it("becomes the size's field store, written as the field and still shown as labels", async () => {
    const { t, calls, client } = jira(
      routes({
        ...SITE,
        "POST issue": { id: "1", key: "ENG-1" },
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          labels: ["bug"],
          fields: { customfield_10050: { value: "M" } },
        }),
      }),
      OVERLAY,
    );
    const size = client.facets.size as ResolvedFacet;
    expect([size.store, size.field, size.why]).toEqual([
      "field",
      "Size",
      "configured",
    ]);
    expect(size.map?.toTracker("size:M")).toBe("M");
    await t.createIssue({
      title: "T",
      description: "",
      labels: [],
      type: "bug",
      priority: 3,
      size: "size:L",
    });
    expect(filed(calls)).toMatchObject({
      customfield_10050: { value: "L" },
      labels: ["bug"],
    });
    const read = await t.getIssue("ENG-1");
    expect([read?.size, read?.labels]).toEqual(["size:M", ["bug", "size:M"]]);
  });

  it("refuses its label among a new issue's labels, pointing at the facet", async () => {
    const { t, calls } = jira(routes(SITE), OVERLAY);
    await expect(
      t.createIssue({ title: "T", description: "", labels: ["size:M"] }),
    ).rejects.toThrow(
      "label 'size:M' is the value of the Jira field 'Size', which keeps the size; give it as the issue's size, not as a label",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("removes a real label with the field's current size while setting the size", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          labels: ["bug", "size:M"],
          fields: { customfield_10050: { value: "M" } },
        }),
        "GET issue/ENG-1/editmeta": {
          fields: { customfield_10050: { allowedValues: SIZE_OPTIONS } },
        },
        "PUT issue/ENG-1": null,
      }),
      OVERLAY,
    );
    await t.updateIssue("ENG-1", { size: "size:M", removeLabels: ["size:M"] });
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      {
        fields: { customfield_10050: { value: "M" } },
        update: { labels: [{ remove: "size:M" }] },
      },
    ]);
  });

  it("refuses removing a size represented only by its field", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          fields: { customfield_10050: { value: "M" } },
        }),
      }),
      OVERLAY,
    );
    await expect(
      t.updateIssue("ENG-1", { removeLabels: ["size:M"] }),
    ).rejects.toThrow("give it as the issue's size, not as a label");
    expect(writes(calls)).toEqual([]);
  });

  it("refuses a label the adapter does not, such as another case of the prefix", async () => {
    const { t, calls } = jira(routes(SITE), OVERLAY);
    await expect(
      t.createIssue({ title: "T", description: "", labels: ["Size:M"] }),
    ).rejects.toThrow("stands for the size size:M");
    expect(writes(calls)).toEqual([]);
  });

  it("stays labels where its labels are not a facet's values", () => {
    const { client } = jira(routes(SITE), {
      issue_tracker: { jira: { field_labels: { Size: "size:" } } },
      taxonomy: JIG_TAXONOMY,
    });
    expect(client.facets.size.store).toBe("label");
  });

  it("refuses an option the field lacks, naming the field's options", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/createmeta/ENG/issuetypes/t3": {
          ...SCREEN,
          fields: [
            { fieldId: "customfield_10050", allowedValues: [{ value: "S" }] },
          ],
        },
      }),
      OVERLAY,
    );
    const err = await t
      .createIssue({
        title: "T",
        description: "",
        labels: [],
        type: "bug",
        priority: 3,
        size: "size:L",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerRequestError);
    expect((err as Error).message).toContain("which has S;");
    expect(writes(calls)).toEqual([]);
  });
});
