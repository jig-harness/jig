import { describe, expect, test } from "bun:test";
import { jira, routes, jqlOf, type Call } from "./jira-fixtures.ts";

describe("Jira open population count estimates", () => {
  test("compares project and scoped JQL without reading issue contents", async () => {
    const { t, calls } = jira(
      routes({
        "GET issue/createmeta/ENG/issuetypes": {
          issueTypes: [
            { id: "10001", name: "Task", subtask: false, hierarchyLevel: 0 },
          ],
          startAt: 0,
          maxResults: 100,
          total: 1,
        },
        "POST search/approximate-count": (c: Call) => ({
          count: jqlOf(c).includes("issuetype") ? 12 : 80,
        }),
      }),
      { issue_tracker: { jira: { pool_issue_types: ["Task"] } } },
    );
    const signal = new AbortController().signal;
    expect(await t.poolScopeCounts?.(signal)).toEqual({
      project: 80,
      pool: 12,
      scoped: true,
      approximate: true,
    });
    const counts = calls.filter(
      (c) => c.route === "POST search/approximate-count",
    );
    expect(counts.map(jqlOf)).toEqual([
      "project = ENG AND statusCategory != Done ORDER BY created ASC",
      "project = ENG AND statusCategory != Done AND issuetype in (10001) ORDER BY created ASC",
    ]);
    expect(counts.every((c) => c.signal === signal)).toBe(true);
    expect(calls.some((c) => c.route === "GET myself")).toBe(true);
    expect(calls.some((c) => c.route === "POST search/jql")).toBe(false);
  });
  test("asks once when unscoped and preserves zero", async () => {
    const { t, calls } = jira(
      routes({ "POST search/approximate-count": { count: 0 } }),
    );
    expect(await t.poolScopeCounts?.()).toEqual({
      project: 0,
      pool: 0,
      scoped: false,
      approximate: true,
    });
    expect(
      calls.filter((c) => c.route === "POST search/approximate-count"),
    ).toHaveLength(1);
  });
  test.each([{}, { count: -1 }, { count: 1.5 }, { count: "8" }])(
    "refuses malformed count %p",
    async (answer) => {
      const { t } = jira(routes({ "POST search/approximate-count": answer }));
      await expect(t.poolScopeCounts?.()).rejects.toThrow(
        "non-negative integer",
      );
    },
  );
  test("forwards an aborted signal before issuing a request", async () => {
    const { t, calls } = jira(routes({}));
    const controller = new AbortController();
    controller.abort();
    await expect(t.poolScopeCounts?.(controller.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
