/**
 * The assigner and mover reads (`assignedBy`, `stateChangedBy`) take the
 * caller's signal on every adapter and give it to each request they make,
 * so a dispatcher tick's deadline ends the read in flight; called without
 * one, they read as they always did.
 */
import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import { gitHub } from "./github-fixtures.ts";
import {
  type Call,
  FACTORY,
  issue as jiraIssue,
  jira,
  MEMBER,
  assignable,
  routes,
} from "./jira-fixtures.ts";

/** A signal that has not fired, as a tick's bound is while it runs. */
const live = () => new AbortController().signal;

describe("GitHub adapter: the assigner read's signal", () => {
  const answer = (c: { op: string }) =>
    c.op === "TrackerAssignedBy"
      ? {
          repository: {
            issue: {
              assignees: { nodes: [{ login: "factory" }] },
              timelineItems: {
                pageInfo: { hasPreviousPage: false },
                nodes: [
                  {
                    createdAt: "2026-10-02T00:00:00Z",
                    actor: { login: "dana" },
                    assignee: { login: "factory" },
                  },
                ],
              },
            },
          },
        }
      : {
          repository: {
            collaborators: {
              edges: [{ permission: "WRITE", node: { login: "dana" } }],
            },
          },
        };

  it("gives the signal to the history read and the permission read", async () => {
    const { t, calls } = gitHub(answer);
    const signal = live();
    expect((await t.assignedBy("#5", undefined, signal)).trusted).toBe(true);
    expect(calls.map((c) => c.op)).toEqual([
      "TrackerAssignedBy",
      "TrackerCollaborator",
    ]);
    expect(calls.every((c) => c.signal === signal)).toBe(true);
  });

  it("starts no request once the signal has aborted", async () => {
    const { t, calls } = gitHub(answer);
    const stopped = new AbortController();
    stopped.abort(new Error("the tick's deadline passed"));
    await expect(
      t.assignedBy("#5", undefined, stopped.signal),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("Linear adapter: the assigner and mover reads' signal", () => {
  const STATES = parseTrackerConfig({}).states;
  const page = (nodes: unknown[]) => ({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes,
  });
  const member = {
    id: "u-d",
    name: "Dana",
    guest: false,
    teams: { nodes: [{ key: "ENG" }] },
  };
  function tracker() {
    const signals: Array<AbortSignal | undefined> = [];
    const transport: LinearTransport = async (_query, _variables, signal) => {
      signals.push(signal);
      return {
        issue: {
          assignee: { id: "u-f", email: "factory@example.invalid" },
          state: { id: "s-todo" },
          creator: member,
          history: page([
            {
              id: "h1",
              createdAt: "2026-10-01T00:00:00Z",
              toAssignee: { id: "u-f", email: "factory@example.invalid" },
              toState: { id: "s-todo" },
              actor: member,
            },
          ]),
        },
      };
    };
    return {
      t: linearTracker({ team: "ENG", states: STATES, transport }),
      signals,
    };
  }

  it("gives the signal to every page of the issue's history", async () => {
    const { t, signals } = tracker();
    const signal = live();
    expect((await t.assignedBy("ENG-4", undefined, signal)).trusted).toBe(true);
    expect((await t.stateChangedBy?.call(t, "ENG-4", signal))?.trusted).toBe(
      true,
    );
    expect(signals).toEqual([signal, signal]);
  });

  it("reads without a signal as before", async () => {
    const { t, signals } = tracker();
    await t.assignedBy("ENG-4");
    expect(signals).toEqual([undefined]);
  });
});

describe("Jira adapter: the assigner and mover reads' signal", () => {
  const on = () =>
    jira(
      routes({
        "GET issue/ENG-7": (c: Call) =>
          c.query.fields === "creator"
            ? { key: "ENG-7", fields: { creator: MEMBER } }
            : jiraIssue({ key: "ENG-7", status: "Todo", assignee: FACTORY }),
        "GET issue/ENG-7/changelog": {
          values: [
            {
              id: "1",
              author: MEMBER,
              created: "2026-01-03T09:00:00.000+0000",
              items: [
                {
                  field: "assignee",
                  fieldId: "assignee",
                  from: null,
                  to: FACTORY.accountId,
                },
              ],
            },
          ],
          startAt: 0,
          maxResults: 100,
          total: 1,
          isLast: true,
        },
        "GET user/assignable/search": assignable(MEMBER.accountId),
      }),
    );
  /** The issue's own reads: the issue, its changelog and its creator, not the shared trust lookup. */
  const own = (calls: Call[]) =>
    calls.filter((c) => c.path.startsWith("issue/ENG-7"));

  it("gives the signal to the issue, its changelog and its creator", async () => {
    const { t, calls } = on();
    const signal = live();
    expect((await t.assignedBy("ENG-7", undefined, signal)).trusted).toBe(true);
    expect((await t.stateChangedBy?.call(t, "ENG-7", signal))?.trusted).toBe(
      true,
    );
    const issueReads = own(calls);
    expect(issueReads.map((c) => c.route)).toEqual([
      "GET issue/ENG-7",
      "GET issue/ENG-7/changelog",
      "GET issue/ENG-7",
      "GET issue/ENG-7/changelog",
      "GET issue/ENG-7",
    ]);
    expect(issueReads.every((c) => c.signal === signal)).toBe(true);
  });

  it("reads without a signal as before", async () => {
    const { t, calls } = on();
    await t.assignedBy("ENG-7");
    expect(own(calls).every((c) => c.signal === undefined)).toBe(true);
  });

  it("ends the wait on the shared trust lookup when the signal aborts", async () => {
    const { t } = jira(
      routes({
        "GET issue/ENG-7": jiraIssue({
          key: "ENG-7",
          status: "Todo",
          assignee: FACTORY,
        }),
        "GET issue/ENG-7/changelog": {
          values: [
            {
              id: "1",
              author: MEMBER,
              created: "2026-01-03T09:00:00.000+0000",
              items: [
                {
                  field: "assignee",
                  fieldId: "assignee",
                  from: null,
                  to: FACTORY.accountId,
                },
              ],
            },
          ],
          startAt: 0,
          maxResults: 100,
          total: 1,
          isLast: true,
        },
        // The lookup never answers: only the signal ends this caller's wait.
        "GET user/assignable/search": () => new Promise(() => undefined),
      }),
    );
    const stop = new AbortController();
    const read = t.assignedBy("ENG-7", undefined, stop.signal);
    setTimeout(() => stop.abort(new Error("the tick's deadline")), 30);
    await expect(read).rejects.toThrow("the tick's deadline");
  });
});
