import { expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import { gitHub, oneIssue } from "./github-fixtures.ts";
import { issue, jira, routes } from "./jira-fixtures.ts";

const signal = new AbortController().signal;

it("reads a GitHub dependency with only the issue's native state", async () => {
  const { t, calls } = gitHub(() => oneIssue({ state: "CLOSED" }));
  expect(await t.dependencyState?.("#12", signal)).toBe("closed");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.query).toContain("issue(number: $number) { state }");
  expect(calls[0]?.signal).toBe(signal);
});

it("reads a Jira dependency's workflow without discovery or children", async () => {
  const { t, calls } = jira(
    routes({
      "GET issue/ENG-12": issue({
        key: "ENG-12",
        status: "Blocked",
        category: "done",
      }),
    }),
    { issue_tracker: { states: { blocked: "Blocked" } } },
  );
  expect(await t.dependencyState?.("ENG-12", signal)).toBe("open");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(
    expect.objectContaining({
      route: "GET issue/ENG-12",
      query: { fields: "status,issuetype,resolution" },
      signal,
    }),
  );
});

it("reads only the Linear dependency's workflow category", async () => {
  const calls: string[] = [];
  const config = parseTrackerConfig({
    issue_tracker: { adapter: "linear", team: "ENG" },
  });
  const tracker = linearTracker({
    team: "ENG",
    states: config.states,
    async transport(query, variables, passedSignal) {
      calls.push(query);
      expect(variables).toEqual({ id: "ENG-12" });
      expect(passedSignal).toBe(signal);
      return { issue: { state: { type: "canceled" } } };
    },
  });
  expect(await tracker.dependencyState?.("ENG-12", signal)).toBe("closed");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("issue(id: $id) { state { type } }");
});
