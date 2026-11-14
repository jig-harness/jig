import { describe, expect, it } from "bun:test";
import assert from "node:assert/strict";

function required<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}
import { conn, gitHub, issueNode } from "./github-fixtures.ts";
import { jira, issue, page, routes, jqlOf, MEMBER } from "./jira-fixtures.ts";

describe("native dispatch sources", () => {
  it("adds requested factory states to each native queue scope", async () => {
    const github = gitHub(() => ({ repository: { issues: conn([]) } }));
    const jiraTracker = jira(
      routes({ "GET user": MEMBER, "POST search/jql": page() }),
    );
    const ghSource = required(github.t.dispatchSource);
    const jiraSource = required(jiraTracker.t.dispatchSource);
    await ghSource.queue("dana");
    required(ghSource.configure)(["queue-closed"]);
    await ghSource.queue("dana");
    expect(github.calls[0]?.query).toContain("states: [OPEN]");
    expect(github.calls[1]?.query).toContain("states: [OPEN, CLOSED]");
    required(jiraSource.configure)(['queue-state:Factory "Done"']);
    await jiraSource.queue(MEMBER.accountId);
    const query = jiraTracker.calls.find(
      (call) => call.route === "POST search/jql",
    );
    expect(jqlOf(required(query))).toContain('"Factory \\"Done\\""');
    expect(jqlOf(required(query))).toContain('"Todo"');
  });

  it("retains Jira epic children from another project like the ordinary child reader", async () => {
    const parent = issue({ key: "ENG-1", type: "Epic", labels: ["epic"] });
    const child = issue({ key: "OPS-2", parent: "ENG-1" });
    const { t } = jira(
      routes({
        "GET user": MEMBER,
        "POST search/jql": (call: Parameters<typeof jqlOf>[0]) => {
          const query = jqlOf(call);
          if (query.includes("assignee")) return page(parent);
          if (query.includes("ENG-1") && !query.includes("project ="))
            return page(child);
          return page();
        },
      }),
    );
    const source = required(t.dispatchSource);
    const rawParent = required((await source.queue(MEMBER.accountId))[0]);
    expect((await source.project(rawParent)).hasOpenChildren).toBe(true);
    const ordinary = await t.openChildren("ENG-1");
    const native = await Promise.all(
      (await source.children("ENG-1")).map((raw) => source.project(raw)),
    );
    expect(native).toEqual(ordinary);
    expect(native.map((value) => value.identifier)).toEqual(["OPS-2"]);
  });

  it("starts no native request or projection after the caller's deadline", async () => {
    const github = gitHub(() => {
      throw new Error("must not read");
    });
    const atlassian = jira(() => {
      throw new Error("must not read");
    });
    for (const tracker of [github.t, atlassian.t]) {
      const source = required(tracker.dispatchSource);
      const options = { deadline: Date.now() - 1 };
      const key = tracker.adapter === "github" ? "#1" : "ENG-1";
      await expect(source.queue("dana", options)).rejects.toThrow("deadline");
      await expect(source.issue(key, options)).rejects.toThrow("deadline");
      await expect(source.children(key, options)).rejects.toThrow("deadline");
      await expect(
        source.project({ identifier: key, value: null }, options),
      ).rejects.toThrow("deadline");
    }
    expect(github.calls).toHaveLength(0);
    expect(atlassian.calls).toHaveLength(0);
  });

  it("does not ask optional native APIs for an explicitly label-kept repository", async () => {
    const { t, calls } = gitHub(
      (call) => {
        if (/issueType|issueFieldValues|projectItems/.test(call.query))
          throw new Error("optional API unavailable");
        return {
          repository: {
            issues: conn([
              issueNode({ number: 1, extra: { subIssues: conn([]) } }),
            ]),
          },
        };
      },
      {
        issue_tracker: {
          facets: {
            type: { store: "label" },
            size: { store: "label" },
            priority: { store: "label" },
          },
        },
        taxonomy: { types: ["feature"], sizes: ["small"] },
      },
    );
    const source = required(t.dispatchSource);
    expect(source.requirements).toEqual([]);
    const read = await source.queue("dana");
    expect((await source.project(required(read[0]))).identifier).toBe("#1");
    expect(calls).toHaveLength(1);
  });

  it("requests the registered native store union before any checkout projects it", async () => {
    const raw = issueNode({
      number: 1,
      issueType: "Feature",
      extra: { subIssues: conn([]) },
    });
    const answer = () => ({ repository: { issues: conn([raw]) } });
    const labels = gitHub(answer, {
      issue_tracker: { facets: { type: { store: "label" } } },
      taxonomy: { types: ["feature"], sizes: null },
    });
    const native = gitHub(answer, {
      issue_tracker: {
        facets: { type: { store: "native", values: { feature: "Feature" } } },
      },
      taxonomy: { types: ["feature"], sizes: null },
    });
    const source = required(labels.t.dispatchSource);
    required(source.configure)([
      ...(source.requirements ?? []),
      ...(required(native.t.dispatchSource).requirements ?? []),
    ]);
    const read = await source.queue("dana");
    expect(labels.calls[0]?.query).toContain("issueType { name }");
    expect((await source.project(required(read[0]))).type).toBeNull();
    expect(
      (await required(native.t.dispatchSource).project(required(read[0]))).type,
    ).toBe("feature");
    expect(native.calls).toHaveLength(0);
  });

  it("projects the same GitHub reading with each checkout's status map and facets", async () => {
    const raw = issueNode({
      number: 7,
      labels: ["Queued", "feature", "small"],
      extra: { subIssues: conn([]), issueFieldValues: conn([]) },
    });
    const answer = () => ({ repository: { issues: conn([raw]) } });
    const first = gitHub(answer, {
      issue_tracker: { states: { todo: "Queued" } },
      taxonomy: { types: ["feature"], sizes: ["small"] },
    });
    const second = gitHub(answer, {
      issue_tracker: { states: { in_progress: "Queued" } },
      taxonomy: { types: ["bug"], sizes: ["large"] },
    });
    expect(first.t.dispatchSource).toBeDefined();
    const read = await required(first.t.dispatchSource).queue("dana");
    const a = await required(first.t.dispatchSource).project(required(read[0]));
    const b = await required(second.t.dispatchSource).project(
      required(read[0]),
    );
    expect(a.state.type).toBe("unstarted");
    expect(b.state.type).toBe("started");
    expect(a.type).toBe("feature");
    expect(a.size).toBe("small");
    expect(b.type).toBeNull();
    expect(b.size).toBeNull();
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
    expect(first.calls[0]?.query).not.toContain("Queued");
  });

  it("keeps Jira's raw fields and child statuses for another checkout to project", async () => {
    const parent = issue({
      key: "ENG-7",
      status: "Queued",
      labels: ["feature", "small"],
      fields: { customfield_123: "kept" },
    });
    const child = issue({
      key: "ENG-8",
      parent: "ENG-7",
      status: "Paused",
      category: "done",
    });
    const answer = routes({
      "GET user": MEMBER,
      "POST search/jql": (call: Parameters<typeof jqlOf>[0]) =>
        jqlOf(call).includes("parent in") ? page(child) : page(parent),
    });
    const first = jira(answer, {
      issue_tracker: { states: { todo: "Queued" } },
      taxonomy: { types: ["feature"], sizes: ["small"] },
    });
    const second = jira(answer, {
      issue_tracker: { states: { in_progress: "Queued", blocked: "Paused" } },
      taxonomy: { types: ["bug"], sizes: ["large"] },
    });
    expect(first.t.dispatchSource).toBeDefined();
    const read = await required(first.t.dispatchSource).queue(MEMBER.accountId);
    const a = await required(first.t.dispatchSource).project(required(read[0]));
    const b = await required(second.t.dispatchSource).project(
      required(read[0]),
    );
    expect(a.state.type).toBe("unstarted");
    expect(b.state.type).toBe("started");
    expect(a.type).toBe("feature");
    expect(b.type).toBeNull();
    expect(a.hasOpenChildren).toBe(false);
    expect(b.hasOpenChildren).toBe(true);
    const queries = first.calls.filter(
      (call) => call.route === "POST search/jql",
    );
    expect(queries[0]?.body.fields).toEqual(["*all"]);
    expect(jqlOf(required(queries[0]))).toContain("status in");
    expect(
      second.calls.filter((call) => call.route === "POST search/jql"),
    ).toHaveLength(0);
    expect(JSON.stringify(read)).toContain("kept");
  });
});
