import { describe, expect, it } from "bun:test";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import {
  type Call,
  conn,
  CREDENTIAL,
  gitHub,
  issueNode,
  JIG_TAXONOMY,
  oneIssue,
  READ_FAILURES,
  repoLabels,
  type TrackerOptions,
  writes,
} from "./github-fixtures.ts";

/** Jig's work types: the taxonomy's docs, chore and infra are Task work. */
const JIG_TYPES = {
  bug: ["bug"],
  feature: ["feature"],
  task: ["docs", "chore", "infra"],
};

/** Jig's stores as the scratch run names them: GitHub's issue types and fields. */
const NAMED: TrackerOptions = {
  taxonomy: JIG_TAXONOMY,
  issue_tracker: {
    types: JIG_TYPES,
    facets: {
      type: { store: "native" },
      priority: { store: "native" },
      size: { store: "field", field: "Effort" },
    },
  },
};

const ISSUE_TYPES = ["Task", "Bug", "Feature", "Chore", "Docs", "Infra"];
const option = (field: string, name: string) => ({
  id: `${field}_${name}`,
  name,
});

/** The repository's issue types and fields, as Jig's organization has them. */
const STORES = {
  repository: {
    issueTypes: conn(ISSUE_TYPES.map((name) => ({ id: `IT_${name}`, name }))),
    issueFields: conn([
      {
        __typename: "IssueFieldSingleSelect",
        id: "IF_priority",
        name: "Priority",
        dataType: "SINGLE_SELECT",
        options: ["Urgent", "High", "Medium", "Low"].map((n) => option("p", n)),
      },
      {
        __typename: "IssueFieldDate",
        id: "IF_start",
        name: "Start date",
        dataType: "DATE",
      },
      {
        __typename: "IssueFieldSingleSelect",
        id: "IF_effort",
        name: "Effort",
        dataType: "SINGLE_SELECT",
        options: JIG_TAXONOMY.sizes.map((n) => option("e", n)),
      },
    ]),
  },
};

/** A field value node as `issueFieldValues` reads it. */
const selected = (field: string, name: string) => ({
  __typename: "IssueFieldSingleSelectValue",
  id: `IFV_${field}`,
  name,
  field: { name: field },
});

/** The error a failed report carries; empty when it has none. */
const errorOf = (v: unknown): string =>
  typeof v === "object" && v !== null && "error" in v ? String(v.error) : "";

const CREATED = {
  createIssue: {
    issue: { number: 40, url: "https://github.com/acme/app/issues/40" },
  },
};

describe("GitHub facets: a repository that names no store", () => {
  it("reads an issue with the queries it always sent, its facets from labels", async () => {
    const { t, calls } = gitHub(
      () =>
        oneIssue(
          issueNode({
            number: 7,
            labels: ["docs", "small", "priority: low", "area:tracker"],
            issueType: "Bug",
            extra: { subIssues: conn([]) },
          }),
        ),
      { taxonomy: JIG_TAXONOMY, issue_tracker: { types: JIG_TYPES } },
    );
    const issue = await t.getIssue("#7");
    expect(calls.map((c) => c.op)).toEqual(["TrackerIssue"]);
    expect(calls[0]?.query).not.toContain("issueFieldValues");
    expect([
      issue?.type,
      issue?.priority,
      issue?.size,
      issue?.nativeType,
    ]).toEqual(["docs", 4, "small", "Bug"]);
    expect(issue?.labels).toEqual(["docs", "small", "area:tracker"]);
  });

  it("files with the request it always sent, type and size as labels", async () => {
    const { t, calls } = gitHub(
      (c) => {
        if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
        if (c.op === "TrackerLabels")
          return repoLabels("bug", "small", "priority: high", "area:tracker");
        if (c.op === "TrackerCreate") return CREATED;
        throw new Error(`unexpected ${c.op}`);
      },
      { taxonomy: JIG_TAXONOMY },
    );
    await t.createIssue({
      title: "New",
      description: "",
      labels: ["area:tracker"],
      type: "bug",
      priority: 2,
      size: "small",
    });
    expect(calls.map((c) => c.op)).toEqual([
      "TrackerLabels",
      "TrackerRepository",
      "TrackerCreate",
    ]);
    expect(calls.at(-1)?.variables.input).toEqual({
      repositoryId: "R_1",
      title: "New",
      body: "",
      labelIds: [
        "LA_3_area:tracker",
        "LA_0_bug",
        "LA_1_small",
        "LA_2_priority: high",
      ],
    });
  });

  it("pools in the order it always did, narrowed by facet", async () => {
    const { t, calls } = gitHub(
      () => ({
        repository: {
          issues: conn([
            issueNode({
              number: 1,
              labels: ["area:x", "small"],
              extra: { subIssues: conn([]) },
            }),
            issueNode({
              number: 2,
              labels: ["area:x", "large"],
              extra: { subIssues: conn([]) },
            }),
            issueNode({
              number: 3,
              labels: ["area:x"],
              extra: { subIssues: conn([]) },
            }),
          ]),
        },
      }),
      { taxonomy: JIG_TAXONOMY },
    );
    const all = await t.openIssues({ withSomeOf: [["area:x"]] });
    expect(all.map((i) => [i.identifier, i.size])).toEqual([
      ["#1", "small"],
      ["#2", "large"],
      ["#3", null],
    ]);
    const small = await t.openIssues({
      withSomeOf: [["area:x"]],
      facets: { oneOf: { size: ["xs", "small"] } },
    });
    expect(small.map((i) => i.identifier)).toEqual(["#1"]);
    const gaps = await t.openIssues({
      withSomeOf: [["area:x"]],
      facets: { missing: ["size"] },
    });
    expect(gaps.map((i) => i.identifier)).toEqual(["#3"]);
    expect(calls.every((c) => c.op === "TrackerIssues")).toBe(true);
    expect(calls[0]?.query).toBe(calls[2]?.query);
    await expect(
      t.openIssues({
        withSomeOf: [["area:x"]],
        facets: { oneOf: { size: ["huge"] } },
      }),
    ).rejects.toThrow("'huge' is not a size");
  });

  it("changes a size label for the new one, reading the issue's labels first", async () => {
    const { t, calls } = gitHub(
      (c) => {
        if (c.op === "TrackerIssue")
          return oneIssue(
            issueNode({
              number: 5,
              labels: ["medium", "bug"],
              extra: { subIssues: conn([]) },
            }),
          );
        if (c.op === "TrackerLabels")
          return repoLabels("medium", "small", "bug");
        return { ok: true };
      },
      { taxonomy: JIG_TAXONOMY },
    );
    await t.updateIssue("#5", { size: "small" });
    expect(writes(calls)).toEqual(["TrackerAddLabels", "TrackerRemoveLabels"]);
    const ids = (op: string) =>
      calls.find((c) => c.op === op)?.variables.labelIds;
    expect([ids("TrackerAddLabels"), ids("TrackerRemoveLabels")]).toEqual([
      ["LA_1_small"],
      ["LA_0_medium"],
    ]);
  });

  it("refuses a priority label among the labels a change adds or removes", async () => {
    const { t, calls } = gitHub(() => ({ ok: true }), {
      taxonomy: JIG_TAXONOMY,
    });
    for (const patch of [
      { addLabels: ["priority: high"] },
      { removeLabels: ["priority: high"] },
    ])
      await expect(t.updateIssue("#5", patch)).rejects.toThrow(
        "'priority: high' stand for a workflow state or a priority; use transition or priority instead",
      );
    expect(calls).toEqual([]);
  });
});

/** Issue #5 carries `labels` the repository's facet stores have since taken over. */
function withLeftoverLabels(labels: string[]) {
  return gitHub((c) => {
    if (c.op === "TrackerIssue")
      return oneIssue(
        issueNode({ number: 5, labels, extra: { subIssues: conn([]) } }),
      );
    if (c.op === "TrackerLabels") return repoLabels(...[...labels].sort());
    if (c.op === "TrackerFacetStores") return STORES;
    return { ok: true };
  }, NAMED);
}

describe("GitHub facets: the issue type and issue fields as named stores", () => {
  it("files a Bug with Priority High and Effort small, and none of them as a label", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
      if (c.op === "TrackerLabels")
        return repoLabels("bug", "small", "priority: high");
      if (c.op === "TrackerFacetStores") return STORES;
      if (c.op === "TrackerCreate") return CREATED;
      throw new Error(`unexpected ${c.op}`);
    }, NAMED);
    await t.createIssue({
      title: "New",
      description: "",
      labels: [],
      type: "bug",
      priority: 2,
      size: "small",
    });
    expect(calls.at(-1)?.variables.input).toEqual({
      repositoryId: "R_1",
      title: "New",
      body: "",
      issueTypeId: "IT_Bug",
      issueFields: [
        { fieldId: "IF_effort", singleSelectOptionId: "e_small" },
        { fieldId: "IF_priority", singleSelectOptionId: "p_High" },
      ],
    });
  });

  it("reads each facet from the issue type and the field values, one request", async () => {
    const { t, calls } = gitHub(
      () =>
        oneIssue(
          issueNode({
            number: 9,
            labels: ["small", "priority: low"],
            issueType: "Docs",
            extra: {
              subIssues: conn([]),
              issueFieldValues: conn([
                selected("Priority", "Urgent"),
                selected("Effort", "xl"),
              ]),
            },
          }),
        ),
      NAMED,
    );
    const issue = await t.getIssue("#9");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("issueFieldValues(first: 25)");
    expect([issue?.type, issue?.priority, issue?.size]).toEqual([
      "docs",
      1,
      "xl",
    ]);
  });

  it("reads an issue with more field values than a page again, alone", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssueFieldValues")
        return {
          repository: {
            issue: {
              issueFieldValues:
                c.variables.after === null
                  ? conn([selected("Start", "x")], "c1")
                  : conn([selected("Effort", "large")]),
            },
          },
        };
      return {
        repository: {
          issues: conn([
            issueNode({
              number: 4,
              labels: ["area:x"],
              issueType: null,
              extra: {
                subIssues: conn([]),
                issueFieldValues: conn([selected("Start", "x")], "c1"),
              },
            }),
          ]),
        },
      };
    }, NAMED);
    const pool = await t.openIssues({ withSomeOf: [["area:x"]] });
    expect(calls.map((c) => c.op)).toEqual([
      "TrackerIssues",
      "TrackerIssueFieldValues",
      "TrackerIssueFieldValues",
    ]);
    expect([pool[0]?.type, pool[0]?.priority, pool[0]?.size]).toEqual([
      null,
      0,
      "large",
    ]);
  });

  it("reads the facets of an issue's open children in the children's request", async () => {
    const { t, calls } = gitHub(
      () => ({
        repository: {
          issue: {
            subIssues: conn([
              issueNode({
                number: 8,
                issueType: "Chore",
                extra: {
                  subIssues: conn([]),
                  issueFieldValues: conn([selected("Effort", "xs")]),
                },
              }),
            ]),
          },
        },
      }),
      NAMED,
    );
    const kids = await t.openChildren("#3");
    expect(calls.map((c) => c.op)).toEqual(["TrackerChildren"]);
    expect(calls[0]?.query).toContain("issueType { name }");
    expect(calls[0]?.query).toContain("issueFieldValues(first: 25)");
    expect([kids[0]?.type, kids[0]?.size]).toEqual(["chore", "xs"]);
  });

  it("changes the type and the fields in the one update request", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue")
        return oneIssue(
          issueNode({ number: 5, extra: { subIssues: conn([]) } }),
        );
      if (c.op === "TrackerFacetStores") return STORES;
      return { updateIssue: { issue: { id: "I_5" } } };
    }, NAMED);
    await t.updateIssue("#5", { type: "feature", priority: 0, size: "medium" });
    expect(writes(calls)).toEqual(["TrackerUpdate"]);
    expect(calls.at(-1)?.variables.input).toEqual({
      id: "I_5",
      issueTypeId: "IT_Feature",
      issueFieldUpdates: [
        { fieldName: "Effort", operation: "SET", value: "medium" },
        { fieldName: "Priority", operation: "CLEAR" },
      ],
    });
  });

  it("takes a leftover priority label off, and refuses putting one on", async () => {
    const { t, calls } = withLeftoverLabels(["priority: high", "bug"]);
    await t.updateIssue("#5", { removeLabels: ["priority: high"] });
    expect(writes(calls)).toEqual(["TrackerRemoveLabels"]);
    expect(calls.at(-1)?.variables.labelIds).toEqual(["LA_1_priority: high"]);
    const added = t.updateIssue("#5", { addLabels: ["Priority: High"] });
    await expect(added).rejects.toBeInstanceOf(TrackerRequestError);
    await expect(added).rejects.toThrow(
      "'Priority: High' stand for a priority, which acme/app keeps in the field 'Priority'",
    );
    await expect(
      t.createIssue({
        title: "x",
        description: "",
        labels: ["priority: high"],
      }),
    ).rejects.toThrow("keeps in the field 'Priority'");
    expect(writes(calls)).toEqual(["TrackerRemoveLabels"]);
  });

  it("refuses a retired type or size label to add, and takes one off", async () => {
    const { t, calls } = withLeftoverLabels(["bug", "small"]);
    const typed = t.updateIssue("#5", { addLabels: ["Bug"] });
    await expect(typed).rejects.toBeInstanceOf(TrackerRequestError);
    await expect(typed).rejects.toThrow(
      "the label 'Bug' stands for the type bug, which this repository keeps in its type, not in labels",
    );
    await expect(t.updateIssue("#5", { addLabels: ["small"] })).rejects.toThrow(
      "the label 'small' stands for the size small, which this repository keeps in the field 'Effort', not in labels",
    );
    await expect(
      t.createIssue({ title: "x", description: "", labels: ["docs"] }),
    ).rejects.toThrow("stands for the type docs");
    expect(writes(calls)).toEqual([]);
    await t.updateIssue("#5", { removeLabels: ["bug", "small"] });
    expect(writes(calls)).toEqual(["TrackerRemoveLabels"]);
    expect(calls.at(-1)?.variables.labelIds).toEqual([
      "LA_0_bug",
      "LA_1_small",
    ]);
  });

  it("refuses a value that names nothing in the store before writing", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
      if (c.op === "TrackerFacetStores")
        return {
          repository: {
            ...STORES.repository,
            issueTypes: conn([{ id: "IT_Bug", name: "Bug" }]),
          },
        };
      throw new Error(`unexpected ${c.op}`);
    }, NAMED);
    const filed = t.createIssue({
      title: "x",
      description: "",
      labels: [],
      type: "docs",
    });
    await expect(filed).rejects.toBeInstanceOf(TrackerRequestError);
    await expect(filed).rejects.toThrow(
      "'docs', which acme/app does not have (it has: Bug)",
    );
    expect(writes(calls)).toEqual([]);
    await expect(
      t.createIssue({ title: "x", description: "", labels: [], size: "huge" }),
    ).rejects.toThrow("'huge' is not a size");
  });

  it("refuses at reading a store GitHub cannot hold", () => {
    expect(() =>
      gitHub(() => null, {
        taxonomy: JIG_TAXONOMY,
        issue_tracker: { facets: { size: { store: "native" } } },
      }),
    ).toThrow("an Effort issue field is a field store");
  });
});

/** Every `l_<facet>_<n>` count the query asks for, answered as the facet's first. */
function labelCounts(
  query: string,
  first: Record<string, { totalCount: number }>,
): Record<string, { totalCount: number }> {
  const out: Record<string, { totalCount: number }> = {};
  for (const m of query.matchAll(/(l_(\w+?)_\d+):/g))
    out[m[1] as string] = first[`l_${m[2]}_0`] ?? { totalCount: 0 };
  return out;
}

describe("GitHub facets: detection and the organization's discovery", () => {
  /** Answers every read for detection, with `fail` answering the reads it names. */
  function answers(fail: (c: Call) => Error | null = () => null) {
    return (c: Call): unknown => {
      const failed = fail(c);
      if (failed !== null) return failed;
      if (c.op === "TrackerFacetEvidence")
        return {
          repository: {
            ...STORES.repository,
            ...labelCounts(c.query, {
              l_type_0: { totalCount: 12 },
              l_priority_0: { totalCount: 30 },
              l_size_0: { totalCount: 0 },
            }),
          },
        };
      if (c.op === "TrackerFacetNativeEvidence") {
        const out: Record<string, unknown> = {};
        for (const m of c.query.matchAll(/(n_\w+):/g))
          out[m[1] as string] = {
            totalCount: m[1]?.startsWith("n_priority") ? 4 : 0,
          };
        return { repository: out };
      }
      if (c.op === "TrackerFacetOwner")
        return {
          repository: { owner: { __typename: "Organization", login: "acme" } },
        };
      if (c.op === "TrackerFacetDiscovery")
        return {
          organization: {
            issueTypes: conn(ISSUE_TYPES.map((name) => ({ name }))),
            issueFields: STORES.repository.issueFields,
          },
        };
      throw new Error(`unexpected ${c.op}`);
    };
  }

  it("reports what the default would select, choosing nothing", async () => {
    const { t, calls } = gitHub(answers(), { taxonomy: JIG_TAXONOMY });
    const stores = await t.facetStores();
    const of = (f: string) => stores.facets.find((s) => s.facet === f);
    expect([
      of("type")?.store,
      of("priority")?.store,
      of("size")?.store,
    ]).toEqual(["label", "label", "label"]);
    expect(of("type")?.detection).toMatchObject({
      status: "read",
      labelEvidence: true,
      wouldSelect: "label",
    });
    expect(of("priority")?.detection).toMatchObject({
      labelEvidence: true,
      nativeEvidence: true,
      wouldSelect: "conflict",
    });
    expect(of("size")?.detection).toMatchObject({
      labelEvidence: false,
      nativeEvidence: false,
      candidate: { store: "field", field: "Effort" },
      wouldSelect: "field",
    });
    expect(of("size")?.pin).toBe("issue_tracker.facets.size: { store: label }");
    expect(stores.discovery).toMatchObject({
      status: "read",
      credential: CREDENTIAL,
    });
    expect(writes(calls)).toEqual([]);
  });

  for (const [name, error] of Object.entries(READ_FAILURES))
    it(`reports a detection read that failed by ${name} as an error, never as labels`, async () => {
      const { t } = gitHub(
        answers((c) => (c.op === "TrackerFacetEvidence" ? error : null)),
        { taxonomy: JIG_TAXONOMY },
      );
      const stores = await t.facetStores();
      for (const s of stores.facets) {
        expect(s.detection?.status).toBe("failed");
        const failed = s.detection as { error: string; unavailable: boolean };
        expect(failed.error).toContain(
          `detection read of acme/app with ${CREDENTIAL}`,
        );
        expect(failed.error).not.toContain("documentation_url");
        expect(failed.error.length).toBeLessThanOrEqual(300);
        expect(failed.unavailable).toBe(name !== "refusal");
        expect(s.detection).not.toHaveProperty("wouldSelect");
      }
      if (name === "rate limit")
        expect(errorOf(stores.facets[0]?.detection)).toContain(
          "retry after 60s",
        );
      if (name === "refusal")
        expect(errorOf(stores.facets[0]?.detection)).toContain(
          "refused (FORBIDDEN)",
        );
    });

  it("reports a denied discovery as unavailable, and fails nothing", async () => {
    const { t } = gitHub(
      answers((c) =>
        c.op === "TrackerFacetDiscovery" ? READ_FAILURES.refusal : null,
      ),
      { taxonomy: JIG_TAXONOMY },
    );
    const stores = await t.facetStores();
    expect(stores.discovery.status).toBe("unavailable");
    expect(stores.facets.every((s) => s.detection?.status === "read")).toBe(
      true,
    );
  });

  it("reports a named store's health from the repository's own fields", async () => {
    const { t } = gitHub((c) => {
      if (c.op === "TrackerFacetStores")
        return {
          repository: {
            ...STORES.repository,
            issueTypes: conn([{ id: "IT_Bug", name: "Bug" }]),
          },
        };
      return answers()(c);
    }, NAMED);
    const stores = await t.facetStores();
    const of = (f: string) => stores.facets.find((s) => s.facet === f);
    expect(of("type")?.health).toMatchObject({ status: "failed" });
    expect(errorOf(of("type")?.health)).toContain("type feature");
    expect([of("priority")?.health, of("size")?.health]).toEqual([
      { status: "ok" },
      { status: "ok" },
    ]);
    expect(of("type")?.detection).toBeUndefined();
  });
});

it("preserves unmapped nonempty GitHub stores for migration refusal", async () => {
  const { t } = gitHub(
    () =>
      oneIssue(
        issueNode({
          number: 9,
          issueType: "Task",
          extra: {
            subIssues: conn([]),
            issueFieldValues: conn([
              selected("Priority", "Unranked"),
              selected("Effort", "Unknown"),
            ]),
          },
        }),
      ),
    NAMED,
  );
  const issue = await t.poolIssue("#9");
  expect(issue?.type).toBeNull();
  expect(issue?.priority).toBe(0);
  expect(issue?.size).toBeNull();
  expect(issue?.unmappedFacets?.slice().sort()).toEqual([
    "priority",
    "size",
    "type",
  ]);
});
