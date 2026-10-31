import { describe, expect, it } from "bun:test";
import { TrackerConfigError } from "../scripts/lib/tracker/config-error.ts";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import { adfToMarkdown } from "../scripts/lib/tracker/jira/adf.ts";
import { JiraApiError } from "../scripts/lib/tracker/jira/transport.ts";
import {
  type Call,
  comment,
  comments,
  issue,
  jira,
  jqlOf,
  MEMBER,
  page,
  routes,
  SITE,
  writes,
} from "./jira-fixtures.ts";

const NOT_FOUND = new JiraApiError("not found", {
  status: 404,
  notFound: true,
});

const LINK_TYPES = {
  issueLinkTypes: [
    { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    { id: "2", name: "Relates", inward: "relates to", outward: "relates to" },
    {
      id: "3",
      name: "Duplicate",
      inward: "is duplicated by",
      outward: "duplicates",
    },
    { id: "4", name: "Cloners", inward: "is cloned by", outward: "clones" },
  ],
};

const PRIORITIES = {
  values: [
    { id: "1", name: "Highest" },
    { id: "2", name: "High" },
    { id: "3", name: "Medium" },
    { id: "4", name: "Low" },
  ],
  startAt: 0,
  maxResults: 100,
  isLast: true,
};

const ISSUE_TYPES = (...types: Array<[string, boolean, number]>) => ({
  issueTypes: types.map(([name, subtask, hierarchyLevel], i) => ({
    id: `t${i}`,
    name,
    subtask,
    hierarchyLevel,
  })),
  startAt: 0,
  maxResults: 100,
  total: types.length,
});

describe("Jira adapter: reading an issue", () => {
  it("maps an issue with state, priority, parent and children onto the port", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-12": issue({
          key: "ENG-12",
          title: "Fix login",
          description: "## Steps\n\n- open the page",
          status: "In Progress",
          category: "indeterminate",
          priority: "High",
          labels: ["bug"],
          type: "Bug",
          parent: "ENG-3",
          assignee: MEMBER,
          fixVersions: ["Q3", "Q4"],
        }),
        "POST search/jql": page(
          issue({
            key: "ENG-13",
            status: "In Review",
            category: "indeterminate",
          }),
          issue({
            key: "ENG-14",
            status: "Canceled",
            category: "done",
            resolution: "Won't Do",
          }),
        ),
      }),
    );
    expect(await t.getIssue("ENG-12")).toEqual({
      id: "10012",
      identifier: "ENG-12",
      title: "Fix login",
      description: "## Steps\n\n- open the page",
      url: `${SITE}/browse/ENG-12`,
      updatedAt: "2026-01-02T09:00:00.000Z",
      state: { name: "In Progress", type: "started" },
      labels: ["bug"],
      nativeType: "Bug",
      parent: { identifier: "ENG-3", title: "Issue ENG-3" },
      children: [
        {
          identifier: "ENG-13",
          title: "Issue ENG-13",
          state: { name: "In Review", type: "started" },
          labels: [],
        },
        {
          identifier: "ENG-14",
          title: "Issue ENG-14",
          state: { name: "Canceled", type: "canceled" },
          labels: [],
        },
      ],
      assignee: "Dana Lee",
      project: "Q3",
    });
    expect(calls[0]?.query.fields).toContain("statuscategorychangedate");
    expect(jqlOf(calls[1] as Call)).toBe(
      "project = ENG AND parent = ENG-12 ORDER BY created ASC",
    );
  });

  it("reads an issue Jira does not have as absent", async () => {
    const { t } = jira(routes({ "GET issue/ENG-9": NOT_FOUND }));
    expect(await t.getIssue("ENG-9")).toBeNull();
  });

  it("keeps an unmapped status's own name, typed by its category", async () => {
    const { t } = jira(
      routes({
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          status: "Waiting for QA",
          category: "indeterminate",
        }),
        "POST search/jql": page(),
      }),
    );
    expect((await t.getIssue("ENG-1"))?.state).toEqual({
      name: "Waiting for QA",
      type: "started",
    });
  });

  it("tells closed states apart by the resolution when they share one status", async () => {
    const overlay = {
      issue_tracker: {
        states: { done: "Done", canceled: "Done", duplicate: "Done" },
      },
    };
    const closed = (resolution: string | null) =>
      jira(
        routes({
          "GET issue/ENG-1": issue({
            key: "ENG-1",
            status: "Done",
            category: "done",
            resolution,
          }),
          "POST search/jql": page(),
        }),
        overlay,
      ).t.getIssue("ENG-1");
    expect((await closed("Done"))?.state.type).toBe("completed");
    expect((await closed("Won't Do"))?.state.type).toBe("canceled");
    expect((await closed("Duplicate"))?.state.type).toBe("duplicate");
    expect((await closed(null))?.state.type).toBe("completed");
  });

  it("lists comments oldest first, bodies in Markdown", async () => {
    const { t } = jira(
      routes({
        "GET issue/ENG-1/comment": comments(
          comment("2", "**second**", MEMBER, "2026-01-05T09:00:00.000+0000"),
          comment("1", "first", MEMBER, "2026-01-04T09:00:00.000+0100"),
        ),
      }),
    );
    expect(await t.listComments("ENG-1")).toEqual([
      { body: "first", createdAt: "2026-01-04T08:00:00.000Z" },
      { body: "**second**", createdAt: "2026-01-05T09:00:00.000Z" },
    ]);
  });
});

describe("Jira adapter: transitions", () => {
  const transitions = (...ts: Array<[string, string, boolean]>) => ({
    transitions: ts.map(([id, to, resolution]) => ({
      id,
      name: `to ${to}`,
      to: { id: `s-${to}`, name: to, statusCategory: { key: "indeterminate" } },
      fields: resolution ? { resolution: { required: true } } : {},
    })),
  });

  it("does nothing when the issue is already in the state", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          status: "in progress",
          category: "indeterminate",
        }),
      }),
    );
    await t.transition("ENG-1", "in_progress");
    expect(calls.map((c) => c.route)).toEqual(["GET issue/ENG-1"]);
  });

  it("takes the one transition to the state's status", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET issue/ENG-1/transitions": transitions(
          ["11", "In Progress", false],
          ["31", "Done", true],
        ),
        "POST issue/ENG-1/transitions": null,
      }),
    );
    await t.transition("ENG-1", "in_progress");
    expect(calls[1]?.query).toEqual({ expand: "transitions.fields" });
    expect(calls[2]?.body).toEqual({ transition: { id: "11" } });
  });

  it("sends the configured resolution when the transition's screen has one", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET issue/ENG-1/transitions": transitions(["31", "Done", true]),
        "POST issue/ENG-1/transitions": null,
      }),
      { issue_tracker: { states: { canceled: "Done", duplicate: "Done" } } },
    );
    await t.transition("ENG-1", "canceled");
    expect(calls[2]?.body).toEqual({
      transition: { id: "31" },
      fields: { resolution: { name: "Won't Do" } },
    });
  });

  it("sends no resolution when the screen has none", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET issue/ENG-1/transitions": transitions(["31", "Done", false]),
        "POST issue/ENG-1/transitions": null,
      }),
    );
    await t.transition("ENG-1", "done");
    expect(calls[2]?.body).toEqual({ transition: { id: "31" } });
  });

  it("refuses a state no single transition reaches, naming what is available", async () => {
    for (const ts of [
      transitions(["11", "In Progress", false]),
      transitions(["31", "Done", false], ["32", "Done", true]),
    ]) {
      const { t, calls } = jira(
        routes({
          "GET issue/ENG-1": issue({ key: "ENG-1" }),
          "GET issue/ENG-1/transitions": ts,
        }),
      );
      const err = await t.transition("ENG-1", "done").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TrackerRequestError);
      expect((err as TrackerRequestError).code).toBe("unresolved");
      expect(String(err)).toContain("'To Do'");
      expect(String(err)).toContain("available: to ");
      expect(writes(calls)).toEqual([]);
    }
  });

  it("surfaces Jira's refusal of a transition with its field errors", async () => {
    const { t } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET issue/ENG-1/transitions": transitions(["31", "Done", false]),
        "POST issue/ENG-1/transitions": new JiraApiError(
          "Jira API HTTP 400 on POST issue/ENG-1/transitions: customfield_1: Story points is required",
          {
            status: 400,
            errors: { customfield_1: "Story points is required" },
          },
        ),
      }),
    );
    await expect(t.transition("ENG-1", "done")).rejects.toThrow(
      "Story points is required",
    );
  });
});

describe("Jira adapter: comments", () => {
  it("posts Markdown as ADF to a key or an id", async () => {
    const { t, calls } = jira(
      routes({
        "POST issue/ENG-1/comment": {},
        "POST issue/10001/comment": {},
      }),
    );
    await t.postComment("ENG-1", "Done in **PR**\n\n<!-- jig:marker -->");
    await t.postComment("10001", "by id");
    expect(adfToMarkdown(calls[0]?.body.body)).toBe(
      "Done in **PR**\n\n<!-- jig:marker -->",
    );
    expect(calls[1]?.route).toBe("POST issue/10001/comment");
  });

  it("sends nothing once the signal is aborted", async () => {
    const { t, calls } = jira(routes({}));
    const abort = new AbortController();
    abort.abort();
    await expect(t.postComment("ENG-1", "x", abort.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(calls).toEqual([]);
  });
});

describe("Jira adapter: filing and patching", () => {
  it("files an issue with labels, a priority and a fix version", async () => {
    const { t, calls } = jira(
      routes({
        "GET priority/search": PRIORITIES,
        "GET project/ENG/versions": [{ id: "70", name: "Q3" }],
        "POST issue": { id: "10050", key: "ENG-50" },
      }),
    );
    expect(
      await t.createIssue({
        title: "New",
        description: "Body",
        labels: ["bug", "area:api"],
        priority: 2,
        project: "Q3",
      }),
    ).toEqual({ identifier: "ENG-50", url: `${SITE}/browse/ENG-50` });
    const fields = calls.at(-1)?.body.fields as Record<string, unknown>;
    expect(fields).toEqual({
      project: { key: "ENG" },
      summary: "New",
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        ],
      },
      issuetype: { name: "Task" },
      labels: ["bug", "area:api"],
      priority: { id: "2" },
      fixVersions: [{ id: "70" }],
    });
  });

  it("omits priority 0 and refuses a label Jira would split", async () => {
    const { t, calls } = jira(
      routes({ "POST issue": { id: "1", key: "ENG-1" } }),
    );
    await t.createIssue({
      title: "T",
      description: "",
      labels: [],
      priority: 0,
    });
    expect(calls.at(-1)?.body.fields).not.toHaveProperty("priority");
    await expect(
      t.createIssue({ title: "T", description: "", labels: ["two words"] }),
    ).rejects.toBeInstanceOf(TrackerRequestError);
  });

  it("picks the issue type by the parent's level", async () => {
    const types = ISSUE_TYPES(
      ["Epic", false, 1],
      ["Task", false, 0],
      ["Sub-task", true, -1],
    );
    const under = async (parent: Record<string, unknown>, overlay = {}) => {
      const { t, calls } = jira(
        routes({
          "GET issue/ENG-2": parent,
          "GET issue/createmeta/ENG/issuetypes": types,
          "POST issue": { id: "1", key: "ENG-9" },
        }),
        overlay,
      );
      await t.createIssue({
        title: "T",
        description: "",
        labels: [],
        parent: "ENG-2",
      });
      const fields = calls.at(-1)?.body.fields as Record<string, unknown>;
      expect(fields.parent).toEqual({ key: "ENG-2" });
      return fields.issuetype;
    };
    expect(
      await under(issue({ key: "ENG-2", type: "Epic", typeLevel: 1 })),
    ).toEqual({ name: "Task" });
    expect(await under(issue({ key: "ENG-2", type: "Task" }))).toEqual({
      name: "Sub-task",
    });
    expect(
      await under(issue({ key: "ENG-2", type: "Task" }), {
        issue_tracker: { jira: { subtask_type: "Subtask" } },
      }),
    ).toEqual({ name: "Subtask" });
    await expect(
      under(issue({ key: "ENG-2", type: "Sub-task", subtask: true })),
    ).rejects.toThrow("sub-task");
  });

  it("refuses to derive a sub-task type the project does not have exactly one of", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-2": issue({ key: "ENG-2" }),
        "GET issue/createmeta/ENG/issuetypes": ISSUE_TYPES(
          ["Task", false, 0],
          ["Sub-task", true, -1],
          ["Sub-bug", true, -1],
        ),
      }),
    );
    const err = await t
      .createIssue({ title: "T", description: "", labels: [], parent: "ENG-2" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerConfigError);
    expect((err as TrackerConfigError).field).toBe(
      "issue_tracker.jira.subtask_type",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("patches fields and labels in one write", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET priority/search": PRIORITIES,
        "PUT issue/ENG-1": null,
      }),
    );
    await t.updateIssue("ENG-1", {
      title: "Renamed",
      priority: 1,
      parent: null,
      addLabels: ["a"],
      removeLabels: ["b"],
    });
    expect(calls.at(-1)?.body).toEqual({
      fields: { summary: "Renamed", priority: { id: "1" }, parent: null },
      update: { labels: [{ add: "a" }, { remove: "b" }] },
    });
  });

  it("moves an issue under a parent that exists", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET issue/ENG-2": issue({ key: "ENG-2" }),
        "PUT issue/ENG-1": null,
      }),
    );
    await t.updateIssue("ENG-1", { parent: "ENG-2" });
    expect(calls.at(-1)?.body).toEqual({
      fields: { parent: { key: "ENG-2" } },
    });
  });

  it("refuses priority 0, an empty patch and an unknown priority before writing", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET priority/search": { ...PRIORITIES, values: [] },
      }),
    );
    for (const patch of [{ priority: 0 }, {}])
      expect(
        (
          (await t
            .updateIssue("ENG-1", patch)
            .catch((e: unknown) => e)) as TrackerRequestError
        ).code,
      ).toBe("invalid");
    expect(
      (
        (await t
          .updateIssue("ENG-1", { priority: 3 })
          .catch((e: unknown) => e)) as TrackerRequestError
      ).code,
    ).toBe("unresolved");
    expect(writes(calls)).toEqual([]);
  });

  it("lists the site's labels across pages", async () => {
    const { t, calls } = jira(
      routes({
        "GET label": (c: Call) =>
          c.query.startAt === 0
            ? {
                values: ["zeta", "alpha"],
                startAt: 0,
                maxResults: 2,
                isLast: false,
              }
            : { values: ["mid"], startAt: 2, maxResults: 2, isLast: true },
      }),
    );
    expect(await t.listLabels()).toEqual([
      { name: "alpha", group: null },
      { name: "mid", group: null },
      { name: "zeta", group: null },
    ]);
    expect(calls.map((c) => c.query.startAt)).toEqual([0, 2]);
  });

  it("searches summaries and descriptions, open issues unless asked", async () => {
    const { t, calls } = jira(
      routes({ "POST search/jql": page(issue({ key: "ENG-4" })) }),
    );
    expect((await t.searchIssues('say "hi"')).map((i) => i.identifier)).toEqual(
      ["ENG-4"],
    );
    await t.searchIssues("x", { includeClosed: true });
    expect(jqlOf(calls[0] as Call)).toBe(
      'project = ENG AND (summary ~ "say \\"hi\\"" OR description ~ "say \\"hi\\"") AND statusCategory != Done ORDER BY created ASC',
    );
    expect(jqlOf(calls[1] as Call)).not.toContain("statusCategory");
    await expect(t.searchIssues(" ")).rejects.toBeInstanceOf(
      TrackerRequestError,
    );
  });
});

describe("Jira adapter: relations", () => {
  it("reads the configured link types in both directions and ignores the rest", async () => {
    const { t } = jira(
      routes({
        "GET issueLinkType": LINK_TYPES,
        "GET issue/ENG-1": issue({
          key: "ENG-1",
          links: [
            { type: "Blocks", outward: "ENG-2" },
            { type: "Blocks", inward: "ENG-3" },
            { type: "Duplicate", outward: "ENG-4" },
            { type: "Duplicate", inward: "ENG-5" },
            { type: "Relates", inward: "ENG-6" },
            { type: "Cloners", outward: "ENG-7" },
          ],
        }),
      }),
    );
    expect(await t.listRelations("ENG-1")).toEqual([
      { type: "blocks", issue: "ENG-2" },
      { type: "blocked_by", issue: "ENG-3" },
      { type: "duplicate", issue: "ENG-4" },
      { type: "duplicated_by", issue: "ENG-5" },
      { type: "related", issue: "ENG-6" },
    ]);
  });

  it("refuses a configured link type the site does not have", async () => {
    const { t } = jira(
      routes({
        "GET issueLinkType": LINK_TYPES,
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
      }),
      { issue_tracker: { jira: { link_types: { blocks: "Blocking" } } } },
    );
    const err = await t.listRelations("ENG-1").catch((e: unknown) => e);
    expect((err as TrackerConfigError).field).toBe(
      "issue_tracker.jira.link_types.blocks",
    );
  });

  it("links the issue as the outward side, once", async () => {
    let linked = false;
    const { t, calls } = jira(
      routes({
        "GET issueLinkType": LINK_TYPES,
        "GET issue/ENG-1": () =>
          issue({
            key: "ENG-1",
            links: linked ? [{ type: "Blocks", outward: "ENG-2" }] : [],
          }),
        "GET issue/ENG-2": issue({ key: "ENG-2" }),
        "POST issueLink": () => {
          linked = true;
          return null;
        },
      }),
    );
    await t.relate("ENG-1", "blocks", "ENG-2");
    await t.relate("ENG-1", "blocks", "ENG-2");
    expect(writes(calls)).toEqual(["POST issueLink"]);
    expect(calls.find((c) => c.route === "POST issueLink")?.body).toEqual({
      type: { name: "Blocks" },
      outwardIssue: { key: "ENG-1" },
      inwardIssue: { key: "ENG-2" },
    });
  });

  it("refuses an issue related to itself", async () => {
    const { t } = jira(routes({}));
    await expect(t.relate("ENG-1", "related", "ENG-1")).rejects.toBeInstanceOf(
      TrackerRequestError,
    );
  });
});

describe("Jira adapter: reach", () => {
  it("reads the project, and names issue_tracker.team when it does not exist", async () => {
    await jira(routes({ "GET project/ENG": { key: "ENG" } })).t.reach();
    const err = await jira(routes({ "GET project/ENG": NOT_FOUND }))
      .t.reach()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerConfigError);
    expect((err as TrackerConfigError).field).toBe("issue_tracker.team");
  });

  it("passes an unavailable Jira on as it is", async () => {
    const down = new JiraApiError("HTTP 503", {
      status: 503,
      unavailable: true,
    });
    await expect(
      jira(routes({ "GET project/ENG": down })).t.reach(),
    ).rejects.toBe(down);
  });
});
