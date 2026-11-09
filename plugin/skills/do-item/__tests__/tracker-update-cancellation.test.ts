import { expect, it } from "bun:test";
import { gitHub, issueNode, conn, repoLabels } from "./github-fixtures.ts";
import { jira, issue as jiraIssue } from "./jira-fixtures.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";

it("stops GitHub updates at each prerequisite request", async () => {
  for (let stop = 1; stop <= 4; stop++) {
    const controller = new AbortController();
    const { t, calls } = gitHub((c, n) => {
      if (n + 1 === stop) controller.abort(new Error("cancelled prerequisite"));
      if (c.op === "TrackerIssue")
        return {
          repository: {
            issue: issueNode({ number: Number(c.variables.number) }),
          },
        };
      if (c.op === "TrackerLabels") return repoLabels("ui");
      if (c.op === "TrackerMilestones")
        return {
          repository: {
            milestones: conn([{ id: "MI", number: 1, title: "Q3" }]),
          },
        };
      throw new Error(`unexpected ${c.op}`);
    });
    await expect(
      t.updateIssue(
        "#1",
        { title: "new", addLabels: ["ui"], project: "Q3", parent: "#2" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled prerequisite");
    expect(calls).toHaveLength(stop);
    expect(calls.every((c) => c.signal === controller.signal)).toBe(true);
  }
});

it("stops Linear updates at each prerequisite request", async () => {
  for (let stop = 1; stop <= 4; stop++) {
    const controller = new AbortController();
    const calls: Array<AbortSignal | undefined> = [];
    const config = parseTrackerConfig({
      issue_tracker: { adapter: "linear", team: "ENG" },
    });
    const t = linearTracker({
      team: "ENG",
      states: config.states,
      transport: async (q, _vars, signal) => {
        calls.push(signal);
        if (calls.length === stop)
          controller.abort(new Error("cancelled prerequisite"));
        if (q.includes("TrackerIssueId("))
          return { issue: { id: "I", team: { id: "T" } } };
        if (q.includes("TrackerProject("))
          return { projects: conn([{ id: "P", name: "Q3" }]) };
        if (q.includes("TrackerLabels("))
          return {
            issueLabels: conn([
              { id: "L", name: "ui", isGroup: false, parent: null },
            ]),
          };
        throw new Error("unexpected request");
      },
    });
    await expect(
      t.updateIssue(
        "ENG-1",
        { title: "new", addLabels: ["ui"], project: "Q3", parent: "ENG-2" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled prerequisite");
    expect(calls).toEqual(
      Array.from({ length: stop }, () => controller.signal),
    );
  }
});

it("stops Jira updates at each prerequisite request", async () => {
  for (let stop = 1; stop <= 4; stop++) {
    const controller = new AbortController();
    const { t, calls } = jira((c, n) => {
      if (n + 1 === stop) controller.abort(new Error("cancelled prerequisite"));
      if (c.path.startsWith("issue/"))
        return jiraIssue({ key: c.path.slice(6) });
      if (c.path === "priority/search")
        return { isLast: true, values: [{ id: "2", name: "High" }] };
      if (c.path === "project/ENG/versions") return [{ id: "V", name: "Q3" }];
      throw new Error(`unexpected ${c.path}`);
    });
    await expect(
      t.updateIssue(
        "ENG-1",
        { title: "new", priority: 2, project: "Q3", parent: "ENG-2" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled prerequisite");
    expect(calls).toHaveLength(stop);
    expect(calls.every((c) => c.signal === controller.signal)).toBe(true);
  }
});

it("stops a Jira issue type read when its only caller gives up, and shares it while another waits", async () => {
  const types = (startAt: number) => ({
    issueTypes: [{ id: `t${startAt}`, name: `T${startAt}`, subtask: false }],
    startAt,
    maxResults: 1,
    total: 3,
  });
  const run = async (second: boolean) => {
    const first = new AbortController();
    const other = new AbortController();
    const { client, calls } = jira((_c, n) => {
      if (n === 0) {
        queueMicrotask(() => first.abort(new Error("gave up")));
        return types(0);
      }
      return types(n);
    });
    const a = client.issueTypes(first.signal);
    const b = second ? client.issueTypes(other.signal) : null;
    await expect(a).rejects.toThrow("gave up");
    if (b !== null) await b;
    await new Promise((r) => setTimeout(r, 20));
    return calls.length;
  };
  expect(await run(false)).toBe(1);
  expect(await run(true)).toBe(3);
});
