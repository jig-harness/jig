/**
 * The tracker port's assignment reads on both adapters: the issues assigned
 * to one user in the given states, and who made an issue's current
 * assignment, trusted only when that user can write to the team's issues.
 */
import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import { conn, gitHub, issueNode } from "./github-fixtures.ts";

const SUB = { subIssues: conn([]) };

describe("GitHub adapter: assignment reads", () => {
  it("lists the open issues assigned to a login in the asked states", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op !== "TrackerIssues") throw new Error(`unexpected ${c.op}`);
      return {
        repository: {
          issues: conn([
            issueNode({ number: 1, assignee: "factory", extra: SUB }),
            issueNode({
              number: 2,
              assignee: "factory",
              labels: ["In Progress"],
              extra: SUB,
            }),
          ]),
        },
      };
    });
    const got = await t.assignedIssues("factory", ["todo"]);
    expect(got.map((i) => i.identifier)).toEqual(["#1"]);
    expect(calls[0]?.variables.filterBy).toEqual({ assignee: "factory" });
    await expect(t.assignedIssues("factory", [])).rejects.toThrow(
      "at least one state",
    );
  });

  it("names who assigned the issue, trusted only with write access", async () => {
    const assigned = (actor: string | null, assignee = "factory") => ({
      repository: {
        issue: {
          assignees: { nodes: [{ login: "factory" }] },
          timelineItems: {
            pageInfo: { hasPreviousPage: false },
            nodes: [
              {
                createdAt: "2026-10-01T00:00:00Z",
                actor: { login: "earlier" },
                assignee: { login: assignee },
              },
              {
                createdAt: "2026-10-02T00:00:00Z",
                actor: actor === null ? null : { login: actor },
                assignee: { login: assignee },
              },
            ],
          },
        },
      },
    });
    const collaborator = (permission: string) => ({
      repository: {
        collaborators: {
          edges: [{ permission, node: { login: "dana" } }],
        },
      },
    });
    for (const [permission, trusted] of [
      ["WRITE", true],
      ["READ", false],
    ] as const) {
      const { t } = gitHub((c) =>
        c.op === "TrackerAssignedBy"
          ? assigned("dana")
          : collaborator(permission),
      );
      expect(await t.assignedBy("#5")).toEqual({
        id: "dana",
        name: "dana",
        trusted,
      });
    }
    const { t: deleted } = gitHub(() => assigned(null));
    await expect(deleted.assignedBy("#5")).rejects.toThrow("names no actor");
    const { t: other } = gitHub(() => assigned("dana", "someone-else"));
    await expect(other.assignedBy("#5")).rejects.toThrow(
      "no assignment event names factory",
    );
  });
});

describe("Linear adapter: assignment reads", () => {
  const STATES = parseTrackerConfig({}).states;
  const page = (nodes: unknown[]) => ({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes,
  });
  function tracker(answer: (variables: Record<string, unknown>) => unknown) {
    const calls: Array<Record<string, unknown>> = [];
    const transport: LinearTransport = async (_query, variables) => {
      calls.push(variables);
      return answer(variables);
    };
    return {
      t: linearTracker({ team: "ENG", states: STATES, transport }),
      calls,
    };
  }

  it("filters by team, assignee and the states' names", async () => {
    const { t, calls } = tracker(() => ({
      issues: page([
        {
          identifier: "ENG-4",
          title: "t",
          url: null,
          priority: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          state: { id: "s-todo", name: "Todo", type: "unstarted" },
          assignee: { id: "u-f", name: "Factory" },
          labels: { pageInfo: { hasNextPage: false }, nodes: [] },
          children: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      ]),
    }));
    const got = await t.assignedIssues("factory@example.invalid", ["todo"]);
    expect(got.map((i) => i.identifier)).toEqual(["ENG-4"]);
    expect(calls[0]?.filter).toEqual({
      and: [
        { team: { key: { eq: "ENG" } } },
        {
          assignee: {
            or: [
              { email: { eqIgnoreCase: "factory@example.invalid" } },
              { displayName: { eqIgnoreCase: "factory@example.invalid" } },
            ],
          },
        },
        { state: { name: { in: ["Todo"] } } },
      ],
    });
  });

  it("names the newest assigner of the identity, trusted as a non-guest team member", async () => {
    const history = (actor: Record<string, unknown> | null) => ({
      issue: {
        assignee: { id: "u-f", email: "factory@example.invalid" },
        history: page([
          {
            id: "h1",
            createdAt: "2026-10-01T00:00:00Z",
            toAssignee: { id: "u-f", email: "factory@example.invalid" },
            actor: {
              id: "u-old",
              name: "Old",
              guest: false,
              teams: { nodes: [{ key: "ENG" }] },
            },
          },
          {
            id: "h2",
            createdAt: "2026-10-02T00:00:00Z",
            toAssignee: { id: "u-f", email: "factory@example.invalid" },
            actor,
          },
          {
            id: "h3",
            createdAt: "2026-10-03T00:00:00Z",
            toAssignee: null,
            actor: { id: "u-x", name: "X", guest: false, teams: { nodes: [] } },
          },
        ]),
      },
    });
    const member = {
      id: "u-d",
      name: "Dana",
      guest: false,
      teams: { nodes: [{ key: "ENG" }] },
    };
    const { t } = tracker(() => history(member));
    expect(await t.assignedBy("ENG-4", "factory@example.invalid")).toEqual({
      id: "u-d",
      name: "Dana",
      trusted: true,
    });
    const { t: guest } = tracker(() => history({ ...member, guest: true }));
    expect((await guest.assignedBy("ENG-4")).trusted).toBe(false);
    const { t: outsider } = tracker(() =>
      history({ ...member, teams: { nodes: [] } }),
    );
    expect((await outsider.assignedBy("ENG-4")).trusted).toBe(false);
    const { t: automation } = tracker(() => history(null));
    await expect(automation.assignedBy("ENG-4")).rejects.toThrow(
      "made by no user",
    );
  });
});
