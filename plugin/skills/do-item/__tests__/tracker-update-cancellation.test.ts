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
