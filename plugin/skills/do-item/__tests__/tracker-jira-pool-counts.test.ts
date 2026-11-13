import { describe, expect, test } from "bun:test";
import {
  type Call,
  issue,
  jira,
  jqlOf,
  page,
  routes,
} from "./jira-fixtures.ts";

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

describe("Jira open population counts", () => {
  test("counts the population the open read keeps, in project and scope", async () => {
    const { t, calls } = jira(
      routes({
        ...TYPES,
        "POST search/jql": (c: Call) =>
          jqlOf(c).includes("issuetype")
            ? page(issue({ key: "ENG-1" }))
            : page(
                issue({ key: "ENG-1" }),
                issue({ key: "ENG-2" }),
                issue({ key: "ENG-3", category: "done", status: "Done" }),
              ),
      }),
      { issue_tracker: { jira: { pool_issue_types: ["Task"] } } },
    );
    const signal = new AbortController().signal;
    expect(await t.poolScopeCounts?.(signal)).toEqual({
      project: 2,
      pool: 1,
      scoped: true,
      approximate: false,
    });
    const searches = calls.filter((c) => c.route === "POST search/jql");
    expect(searches.map(jqlOf)).toEqual([
      "project = ENG AND statusCategory != Done ORDER BY created ASC",
      "project = ENG AND statusCategory != Done AND issuetype in (10001) ORDER BY created ASC",
    ]);
    expect(searches.every((c) => c.signal === signal)).toBe(true);
    expect(
      searches.every(
        (c) =>
          JSON.stringify((c.body as { fields?: unknown }).fields) ===
          '["status"]',
      ),
    ).toBe(true);
    expect(calls.some((c) => c.route === "POST search/approximate-count")).toBe(
      false,
    );
  });
  test("reads once when unscoped and preserves zero", async () => {
    const { t, calls } = jira(routes({ "POST search/jql": page() }));
    expect(await t.poolScopeCounts?.()).toEqual({
      project: 0,
      pool: 0,
      scoped: false,
      approximate: false,
    });
    expect(calls.filter((c) => c.route === "POST search/jql")).toHaveLength(1);
  });
  test("forwards an aborted signal before issuing a request", async () => {
    const { t, calls } = jira(routes({}));
    const controller = new AbortController();
    controller.abort();
    await expect(t.poolScopeCounts?.(controller.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
