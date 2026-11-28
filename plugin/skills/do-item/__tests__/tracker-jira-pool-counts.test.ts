import { describe, expect, test } from "bun:test";
import { type Call, jira, jqlOf, routes } from "./jira-fixtures.ts";

const TYPES = {
  "GET issue/createmeta/ENG/issuetypes": {
    issueTypes: [
      { id: "10001", name: "Task", subtask: false, hierarchyLevel: 0 },
    ],
    startAt: 0,
    maxResults: 100,
    total: 1,
  },
};

const COUNT = "POST search/approximate-count";

describe("Jira open population counts", () => {
  test("asks Jira for an estimate of the project and the scope, one request each, reading no issue", async () => {
    const { t, calls } = jira(
      routes({
        ...TYPES,
        [COUNT]: (c: Call) =>
          jqlOf(c).includes("issuetype") ? { count: 1200 } : { count: 9800 },
      }),
      { issue_tracker: { jira: { pool_issue_types: ["Task"] } } },
    );
    const signal = new AbortController().signal;
    expect(await t.poolScopeCounts?.(signal)).toEqual({
      project: 9800,
      pool: 1200,
      scoped: true,
      approximate: true,
    });
    const counts = calls.filter((c) => c.route === COUNT);
    expect(counts.map(jqlOf)).toEqual([
      "project = ENG AND statusCategory != Done",
      "project = ENG AND statusCategory != Done AND issuetype in (10001)",
    ]);
    expect(counts.every((c) => c.signal === signal)).toBe(true);
    expect(calls.some((c) => c.route === "POST search/jql")).toBe(false);
  });
  test("counts the configured blocked status as open, as the open read selects it", async () => {
    const { t, calls } = jira(routes({ [COUNT]: { count: 3 } }), {
      issue_tracker: {
        jira: { states_by_type: { Epic: { blocked: "Waiting" } } },
      },
    });
    expect((await t.poolScopeCounts?.())?.project).toBe(3);
    expect(jqlOf(calls.find((c) => c.route === COUNT) as Call)).toContain(
      'status = "Waiting"',
    );
  });
  test("refuses an answer without a count instead of inventing one", async () => {
    for (const answer of [{}, { count: -1 }, { count: 1.5 }, { count: "9" }]) {
      const { t } = jira(routes({ [COUNT]: answer }));
      await expect(t.poolScopeCounts?.()).rejects.toThrow(/count/);
    }
  });
  test("asks once when unscoped and preserves zero", async () => {
    const { t, calls } = jira(routes({ [COUNT]: { count: 0 } }));
    expect(await t.poolScopeCounts?.()).toEqual({
      project: 0,
      pool: 0,
      scoped: false,
      approximate: true,
    });
    expect(calls.filter((c) => c.route === COUNT)).toHaveLength(1);
  });
  test("forwards an aborted signal before issuing a request", async () => {
    const { t, calls } = jira(routes({}));
    const controller = new AbortController();
    controller.abort();
    await expect(t.poolScopeCounts?.(controller.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
