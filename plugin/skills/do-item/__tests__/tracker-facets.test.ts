import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  facetInputs,
  facetsOf,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import {
  readTaxonomyValues,
  resolveFacets,
  type ResolvedFacet,
  type TaxonomyValues,
} from "../scripts/lib/tracker/facets/config.ts";
import { labelCodec } from "../scripts/lib/tracker/facets/label.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import { linearFacets } from "../scripts/lib/tracker/linear-facets.ts";
import { parseNewIssue, parsePatch } from "../scripts/tracker.ts";
import { gitHub, issueNode, conn, JIG_TAXONOMY } from "./github-fixtures.ts";
import { jira, routes } from "./jira-fixtures.ts";

const TAXONOMY: TaxonomyValues = {
  path: "label-taxonomy.yaml",
  ...JIG_TAXONOMY,
};

/** The facets of an overlay's `issue_tracker` section, with Jig's taxonomy unless `taxonomy` is null. */
function facets(
  section: Record<string, unknown>,
  taxonomy: TaxonomyValues | null = TAXONOMY,
) {
  return resolveFacets(
    facetInputs(parseTrackerConfig({ issue_tracker: section })),
    taxonomy,
  );
}

const resolved = (slot: unknown) => slot as ResolvedFacet;

describe("issue_tracker.facets: what a repository that sets nothing keeps", () => {
  it("keeps every facet in the store each adapter has today", () => {
    const github = facets({ adapter: "github" });
    expect([
      github.type.store,
      github.priority.store,
      github.size.store,
    ]).toEqual(["label", "label", "label"]);
    expect(resolved(github.priority).labels?.[1]).toEqual([
      "high",
      ["priority: high"],
    ]);
    for (const adapter of ["linear", "jira"]) {
      const f = facets({
        adapter,
        team: "ENG",
        ...(adapter === "jira"
          ? { jira: { site: "https://x.atlassian.net" } }
          : {}),
      });
      expect([f.type.store, f.priority.store, f.size.store]).toEqual([
        "label",
        "native",
        "label",
      ]);
      expect(f.priority.why).toBe("default");
    }
  });

  it("reads today's keys as their facet's label form", () => {
    const f = facets({
      types: {
        bug: ["bug", "type:bug"],
        feature: ["feature"],
        task: ["docs", "chore", "infra"],
      },
      github: { priority_labels: { urgent: "P0" } },
    });
    expect([
      resolved(f.type).why,
      f.priority.why,
      resolved(f.size).why,
    ]).toEqual(["kept in labels", "kept in labels", "default"]);
    const type = resolved(f.type);
    expect(type.values).toEqual(JIG_TAXONOMY.types);
    expect(type.labels?.[0]).toEqual(["bug", ["bug", "type:bug"]]);
    expect(type.labels?.[2]).toEqual(["docs", ["docs"]]);
    expect(resolved(f.priority).labels?.[0]).toEqual(["urgent", ["P0"]]);
  });

  it("has the work types as its types and no size facet without a taxonomy", () => {
    const f = facets({}, null);
    const type = resolved(f.type);
    expect(type.values).toEqual([
      "bug",
      "feature",
      "improvement",
      "task",
      "spike",
    ]);
    expect(type.labels?.[3]).toEqual(["task", ["task", "type:task"]]);
    expect(f.size).toEqual({ facet: "size", store: null, problem: null });
  });
});

describe("issue_tracker.facets: what reading the configuration refuses", () => {
  const refused: Array<[string, Record<string, unknown>, string]> = [
    [
      "a facet that is none",
      { facets: { due: { store: "label" } } },
      "is not a facet",
    ],
    [
      "a field a facet has not",
      { facets: { type: { store: "label", map: {} } } },
      "is not a field of a facet",
    ],
    [
      "an entry naming no store",
      { facets: { type: { labels: { bug: "b" } } } },
      "must name its store",
    ],
    [
      "an issue type on Linear",
      { adapter: "linear", team: "ENG", facets: { type: { store: "native" } } },
      "Linear has no issue types",
    ],
    [
      "a native size on Jira, whose estimate is a custom field",
      { adapter: "jira", team: "ENG", facets: { size: { store: "native" } } },
      "each site's estimate is a custom field",
    ],
    [
      "priority in a Jira custom field",
      {
        adapter: "jira",
        team: "ENG",
        facets: { priority: { store: "field", field: "Rank" } },
      },
      "Jira keeps priority in its own priority field",
    ],
    [
      "a custom field on Linear",
      {
        adapter: "linear",
        team: "ENG",
        facets: { size: { store: "field", field: "Size" } },
      },
      "the Linear adapter has no custom field to name",
    ],
    [
      "a field store with no field",
      { facets: { size: { store: "field" } } },
      "must name the field",
    ],
    [
      "labels beside a prefix",
      {
        facets: {
          size: { store: "label", labels: { xs: "XS" }, prefix: "size:" },
        },
      },
      "keep one",
    ],
    [
      "a priority that is none",
      { facets: { priority: { store: "label", labels: { critical: "P0" } } } },
      "critical is not a value",
    ],
    [
      "two priorities in one label",
      {
        facets: {
          priority: { store: "label", labels: { urgent: "P0", high: "p0" } },
        },
      },
      "gives urgent and high the one tracker value",
    ],
    [
      "priority labels a Jira label cannot hold",
      {
        adapter: "jira",
        team: "ENG",
        facets: { priority: { store: "label" } },
      },
      "must name them",
    ],
    [
      "priority labels that disagree with priority_labels",
      {
        github: { priority_labels: { urgent: "P0" } },
        facets: { priority: { store: "label", prefix: "prio:" } },
      },
      "keep one, or make them agree",
    ],
    [
      "Jira priorities that disagree",
      {
        adapter: "jira",
        team: "ENG",
        jira: { priorities: { urgent: "Blocker" } },
        facets: {
          priority: { store: "native", values: { urgent: "Highest" } },
        },
      },
      "keep one, or make them agree",
    ],
  ];
  for (const [what, section, message] of refused)
    it(`refuses ${what}`, () => {
      const jiraSite =
        section.adapter === "jira"
          ? {
              jira: {
                site: "https://x.atlassian.net",
                ...(section.jira as object),
              },
            }
          : {};
      expect(() => facets({ ...section, ...jiraSite })).toThrow(message);
    });

  it("refuses, once the taxonomy is known, a value map key and a label two facts share", () => {
    expect(() =>
      facets({
        facets: { type: { store: "native", values: { incident: "Incident" } } },
      }),
    ).toThrow("issue_tracker.facets.type.values.incident is not a value");
    expect(() =>
      facets({
        states: { in_review: "small" },
        facets: { size: { store: "label" } },
      }),
    ).toThrow("which is also the label of a workflow state");
    expect(() =>
      facets({
        facets: { type: { store: "label", prefix: "kind:" } },
        types: { bug: ["bug"] },
      }),
    ).toThrow("issue_tracker.types marks it with bug");
    expect(() =>
      facets(
        { facets: { size: { store: "label" } } },
        { ...TAXONOMY, sizes: null },
      ),
    ).toThrow("has no size group");
  });

  it("seeds Jira's priorities from a native priority's values", () => {
    const { jira } = parseTrackerConfig({
      issue_tracker: {
        adapter: "jira",
        team: "ENG",
        jira: { site: "https://x.atlassian.net" },
        facets: {
          priority: { store: "native", values: { urgent: "Blocker" } },
        },
      },
    });
    expect(jira.priorities.urgent).toEqual(["Blocker"]);
  });
});

describe("the label taxonomy the type and size values come from", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const repo = (taxonomy: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "jig-facets-"));
    dirs.push(dir);
    if (taxonomy !== null)
      writeFileSync(join(dir, "label-taxonomy.yaml"), taxonomy);
    return dir;
  };
  const GOOD = `version: 1
types:
  - id: bug
  - id: docs
statuses:
  - id: todo
groups:
  - id: size
    required: true
    labels:
      - id: small
      - id: large
`;

  it("reads its types and size group, and none where it is missing", () => {
    expect(readTaxonomyValues(repo(GOOD), "label-taxonomy.yaml")).toMatchObject(
      {
        types: ["bug", "docs"],
        sizes: ["small", "large"],
      },
    );
    expect(readTaxonomyValues(repo(null), "label-taxonomy.yaml")).toBeNull();
  });

  it("leaves type and size unreadable when it fails its lint, including explicit stores", () => {
    const broken = repo("version: 1\ntypes: oops\n");
    const config = parseTrackerConfig({});
    const f = facetsOf(config, broken);
    expect(f.type).toMatchObject({
      store: null,
      problem: expect.stringContaining("fails its lint"),
    });
    expect(f.priority.store).toBe("label");
    expect(
      facetsOf(
        parseTrackerConfig({
          issue_tracker: {
            facets: { type: { store: "label" }, size: { store: "label" } },
          },
        }),
        broken,
      ).type,
    ).toMatchObject({
      store: null,
      problem: expect.stringContaining("fails its lint"),
    });
  });
});

describe("the label store", () => {
  const type = labelCodec(
    resolved(
      facets({ types: { bug: ["bug", "type:bug"], task: ["docs", "chore"] } })
        .type,
    ),
  );
  const priority = labelCodec(
    resolved(
      facets({
        adapter: "linear",
        team: "ENG",
        facets: { priority: { store: "label", prefix: "P:" } },
      }).priority,
    ),
  );

  it("reads one value, none for two, and the more urgent of two priorities", () => {
    expect([
      type.read(["type:bug", "area:x"]),
      type.read(["area:x"]),
      type.read(["bug", "docs"]),
    ]).toEqual(["bug", null, null]);
    expect(type.read(["bug", "type:bug"])).toBe("bug");
    expect(priority.read(["P:low", "P:high"])).toBe("high");
  });

  it("writes a value's first label and takes the facet's others off", () => {
    expect(type.change(["type:bug", "area:x"], "docs")).toEqual({
      add: ["docs"],
      remove: ["type:bug"],
    });
    expect(type.change(["docs"], "docs")).toEqual({ add: [], remove: [] });
    expect(type.change(["docs", "chore"], null)).toEqual({
      add: [],
      remove: ["docs", "chore"],
    });
  });
});

describe("the facets on Linear and Jira, with today's behaviour", () => {
  type Call = { query: string; variables: Record<string, unknown> };
  const page = (nodes: unknown[]) => ({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes,
  });
  const LABELS = ["bug", "docs", "small", "large", "P:high"].map((name) => ({
    id: `l-${name}`,
    name,
    isGroup: false,
    parent: null,
  }));

  function linear(section: Record<string, unknown> = {}) {
    const calls: Call[] = [];
    const transport: LinearTransport = async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes("TrackerTeam("))
        return { teams: page([{ id: "team-1", key: "ENG" }]) };
      if (query.includes("TrackerLabels("))
        return { issueLabels: page(LABELS) };
      if (query.includes("TrackerCreate("))
        return {
          issueCreate: {
            success: true,
            issue: { identifier: "ENG-9", url: null },
          },
        };
      if (query.includes("TrackerPoolIssue("))
        return {
          issue: {
            identifier: "ENG-1",
            title: "t",
            url: null,
            priority: 3,
            createdAt: "2026-01-01T00:00:00Z",
            state: { id: "s", name: "Todo", type: "unstarted" },
            assignee: null,
            labels: page([{ name: "large" }, { name: "bug" }]),
            children: page([]),
          },
        };
      if (query.includes("TrackerIssueId("))
        return { issue: { id: "uuid-1", team: { id: "team-1", key: "ENG" } } };
      if (query.includes("TrackerUpdate("))
        return { issueUpdate: { success: true } };
      throw new Error(`unexpected ${query.slice(0, 40)}`);
    };
    const config = parseTrackerConfig({
      issue_tracker: { adapter: "linear", team: "ENG", ...section },
    });
    const t = linearTracker({
      team: "ENG",
      states: config.states,
      transport,
      facets: resolveFacets(facetInputs(config), TAXONOMY),
    });
    return { t, calls };
  }

  it("files type and size as labels on Linear, and priority in its own field", async () => {
    const { t, calls } = linear();
    await t.createIssue({
      title: "x",
      description: "",
      labels: [],
      type: "bug",
      priority: 2,
      size: "small",
    });
    expect(calls.at(-1)?.variables.input).toEqual({
      teamId: "team-1",
      title: "x",
      description: "",
      labelIds: ["l-bug", "l-small"],
      priority: 2,
    });
  });

  it("keeps priority in labels on Linear where a store names them", async () => {
    const { t, calls } = linear({
      facets: { priority: { store: "label", prefix: "P:" } },
    });
    await t.createIssue({
      title: "x",
      description: "",
      labels: [],
      priority: 2,
    });
    expect(calls.at(-1)?.variables.input).toEqual({
      teamId: "team-1",
      title: "x",
      description: "",
      labelIds: ["l-P:high"],
    });
    expect((await t.poolIssue("ENG-1"))?.priority).toBe(0);
  });

  it("refuses a facet's label among a new issue's labels, pointing at the facet", async () => {
    const { t, calls } = linear({
      facets: { priority: { store: "label", prefix: "P:" } },
    });
    await expect(
      t.createIssue({
        title: "x",
        description: "",
        labels: ["P:high"],
        priority: 0,
      }),
    ).rejects.toThrow(
      "the label 'P:high' to file is the priority high; give it as the issue's priority (priority: 2 (high)), not as a label",
    );
    await expect(
      t.createIssue({ title: "x", description: "", labels: ["feature"] }),
    ).rejects.toThrow(/give it as the issue's type \(type: feature\)/);
    expect(calls).toEqual([]);
  });

  it("refuses a facet's label among the labels a change adds, its alias included", async () => {
    const { t, calls } = linear();
    await expect(
      t.updateIssue("ENG-1", { type: "bug", addLabels: ["type:bug"] }),
    ).rejects.toThrow(
      "the label 'type:bug' to add is the type bug; give it as the issue's type (type: bug), not as a label",
    );
    expect(calls).toEqual([]);
  });

  it("changes a size on Linear in one update, from the issue's labels", async () => {
    const { t, calls } = linear();
    await t.updateIssue("ENG-1", { size: "small", type: null });
    expect(calls.at(-1)?.variables.input).toEqual({
      addedLabelIds: ["l-small"],
      removedLabelIds: ["l-bug", "l-large"],
    });
    const before = calls.length;
    await t.updateIssue("ENG-1", { size: "large" });
    expect(calls.length).toBe(before + 1);
  });

  it("files type and size as labels on Jira, its issue type as configured", async () => {
    const { t, calls } = jira(
      routes({ "POST issue": { id: "1", key: "ENG-1" } }),
      { taxonomy: JIG_TAXONOMY },
    );
    await t.createIssue({
      title: "T",
      description: "",
      labels: ["area:x"],
      type: "docs",
      size: "large",
    });
    const fields = calls.at(-1)?.body.fields as Record<string, unknown>;
    expect([fields.issuetype, fields.labels]).toEqual([
      { name: "Task" },
      ["area:x", "docs", "large"],
    ]);
    expect(calls.map((c) => c.route)).toEqual(["POST issue"]);
  });
});

describe("incompleteIssues", () => {
  const open = (number: number, labels: string[], created: string) =>
    issueNode({
      number,
      labels,
      createdAt: created,
      extra: { subIssues: conn([]) },
    });
  const TRACKER = () =>
    gitHub(
      () => ({
        repository: {
          issues: conn([
            open(1, ["bug", "small", "priority: high"], "2026-01-01T00:00:00Z"),
            open(2, ["docs"], "2026-01-02T00:00:00Z"),
            open(
              3,
              ["epic", "feature", "priority: low"],
              "2026-01-03T00:00:00Z",
            ),
            open(4, ["Triage"], "2026-01-04T00:00:00Z"),
            open(5, ["In Progress"], "2026-01-05T00:00:00Z"),
            open(6, ["Backlog", "legacy-size"], "2026-01-06T00:00:00Z"),
            open(7, [], "2026-01-07T00:00:00Z"),
          ]),
        },
      }),
      { taxonomy: JIG_TAXONOMY },
    );

  it("lists issues not started that lack a facet or carry a retired label, with counts over the open issues", async () => {
    const { t } = TRACKER();
    const first = await t.incompleteIssues({
      missing: ["type", "priority", "size"],
      retired: ["legacy-size"],
      limit: 2,
    });
    expect(
      first.issues.map((i) => [i.identifier, i.missing, i.retired]),
    ).toEqual([
      ["#2", ["priority", "size"], []],
      ["#6", ["type", "priority", "size"], ["legacy-size"]],
    ]);
    expect(first.counts).toEqual({
      type: { required: 6, lacking: 3 },
      priority: { required: 6, lacking: 4 },
      size: { required: 5, lacking: 4 },
    });
    const second = await t.incompleteIssues({
      missing: ["type", "priority", "size"],
      retired: [],
      after: first.next,
      limit: 2,
    });
    expect(second.issues.map((i) => i.identifier)).toEqual(["#7"]);
    expect(second.next).toBeNull();
  });

  it("refuses a page size outside 1 to 100 and a facet with no store", async () => {
    const { t } = TRACKER();
    await expect(
      t.incompleteIssues({ missing: ["type"], retired: [], limit: 0 }),
    ).rejects.toThrow("1 to 100");
    const none = gitHub(() => null).t;
    await expect(
      none.incompleteIssues({ missing: ["size"], retired: [], limit: 10 }),
    ).rejects.toThrow("no size facet");
  });
});

describe("tracker.ts create and update take the facets", () => {
  it("reads type and size, and a patch's null that removes one", () => {
    expect(
      parseNewIssue('{"title":"x","type":"bug","priority":2,"size":"small"}'),
    ).toEqual({
      title: "x",
      description: "",
      labels: [],
      type: "bug",
      priority: 2,
      size: "small",
    });
    expect(parsePatch("#1", '{"type":null,"size":"xs"}')).toEqual({
      type: null,
      size: "xs",
    });
    expect(() => parseNewIssue('{"title":"x","size":3}')).toThrow(
      "'size' must be a nonempty value",
    );
    expect(() => parseNewIssue('{"title":"x","type":null}')).toThrow(
      "'type' must be",
    );
  });
});

describe("issue_tracker.facets: values and maps the configuration must keep", () => {
  it("refuses a label key that is not a value of the facet", () => {
    expect(() =>
      facets({
        adapter: "github",
        facets: { size: { store: "label", labels: { smal: "S" } } },
      }),
    ).toThrow("not a size of this repository");
  });

  it("refuses a Linear priority map onto other numbers", () => {
    const remapped = facets({
      adapter: "linear",
      team: "ENG",
      facets: {
        priority: {
          store: "native",
          values: { urgent: "4", high: "3", medium: "2", low: "1" },
        },
      },
    });
    expect(() => linearFacets({} as never, remapped)).toThrow(
      "cannot remap Linear's native priority",
    );
  });
});
