/**
 * The tracker port's ready-pool reads on each adapter: the open issues
 * assigned to nobody in the given states, and who made an issue's latest
 * move into the state it is in now, trusted only when that user can write
 * to the team's issues.
 */
import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import type { Tracker } from "../scripts/lib/tracker/port.ts";
import {
  conn,
  gitHub,
  issueNode,
  ON_BOARD,
  oneIssue,
} from "./github-fixtures.ts";
import {
  APP,
  assignable,
  type Call,
  issue as jiraIssue,
  jira,
  jqlOf,
  MEMBER,
  page as jiraPage,
  routes,
} from "./jira-fixtures.ts";

const SUB = { subIssues: conn([]) };

/** The adapter's ready-pool reads, which every adapter implements. */
function poolReads(t: Tracker) {
  const { unassignedIssues, stateChangedBy } = t;
  if (unassignedIssues === undefined || stateChangedBy === undefined)
    throw new Error(`the ${t.adapter} adapter has no ready-pool reads`);
  return {
    unassigned: (states: Parameters<typeof unassignedIssues>[0]) =>
      unassignedIssues.call(t, states),
    movedBy: (key: string) => stateChangedBy.call(t, key),
  };
}

describe("GitHub adapter: ready-pool reads", () => {
  const collaborator = (permission: string) => ({
    repository: {
      collaborators: { edges: [{ permission, node: { login: "dana" } }] },
    },
  });
  const timeline = (
    nodes: unknown[],
    more = false,
    author: string | null = "opener",
  ) => ({
    repository: {
      issue: {
        author: author === null ? null : { login: author },
        timelineItems: { pageInfo: { hasPreviousPage: more }, nodes },
      },
    },
  });
  const labelled = (label: string, actor: string | null, at: string) => ({
    __typename: "LabeledEvent",
    createdAt: at,
    actor: actor === null ? null : { login: actor },
    label: { name: label },
  });
  const unlabelled = (label: string, actor: string, at: string) => ({
    __typename: "UnlabeledEvent",
    createdAt: at,
    actor: { login: actor },
    label: { name: label },
  });
  /** A tracker whose issue #5 carries `labels` and whose timeline is `events`. */
  function on(
    labels: string[],
    events: ReturnType<typeof timeline>,
    permission = "WRITE",
  ) {
    return gitHub((c) => {
      if (c.op === "TrackerIssue")
        return oneIssue(issueNode({ number: 5, labels, extra: SUB }));
      if (c.op === "TrackerStateChanges") return events;
      if (c.op === "TrackerCollaborator") return collaborator(permission);
      throw new Error(`unexpected ${c.op}`);
    });
  }

  it("lists the open issues assigned to nobody in the asked states", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op !== "TrackerIssues") throw new Error(`unexpected ${c.op}`);
      return {
        repository: {
          issues: conn([
            issueNode({ number: 1, extra: SUB }),
            issueNode({ number: 2, assignee: "dana", extra: SUB }),
            issueNode({ number: 3, labels: ["In Progress"], extra: SUB }),
          ]),
        },
      };
    });
    const read = poolReads(t);
    expect((await read.unassigned(["todo"])).map((i) => i.identifier)).toEqual([
      "#1",
    ]);
    expect(calls[0]?.variables.filterBy).toEqual({});
    await expect(read.unassigned([])).rejects.toThrow("at least one state");
  });

  it("names who labelled the issue into its state, trusted only with write access", async () => {
    const events = timeline([
      labelled("Backlog", "earlier", "2026-10-01T00:00:00Z"),
      labelled("Backlog", "dana", "2026-10-02T00:00:00Z"),
      labelled("bug", "someone", "2026-10-03T00:00:00Z"),
    ]);
    const labels = on(["Backlog"], events);
    expect(await poolReads(labels.t).movedBy("#5")).toEqual({
      id: "dana",
      name: "dana",
      trusted: true,
    });
    // A board's events need a scope a tracker on labels does not hold.
    const asked = labels.calls.find((c) => c.op === "TrackerStateChanges");
    expect(asked?.query).not.toContain("PROJECT_V2");
    expect(
      (await poolReads(on(["Backlog"], events, "READ").t).movedBy("#5"))
        .trusted,
    ).toBe(false);
  });

  it("names who took a higher state label off, exposing the issue's state", async () => {
    const events = timeline([
      labelled("Backlog", "dana", "2026-10-01T00:00:00Z"),
      labelled("In Progress", "dana", "2026-10-02T00:00:00Z"),
      unlabelled("In Progress", "outsider", "2026-10-03T00:00:00Z"),
    ]);
    const mover = await poolReads(on(["Backlog"], events, "READ").t).movedBy(
      "#5",
    );
    expect(mover.name).toBe("outsider");
    expect(mover.trusted).toBe(false);
  });

  it("names who took the last state label off an issue in the state that carries none", async () => {
    const events = timeline([
      labelled("In Progress", "dana", "2026-10-01T00:00:00Z"),
      unlabelled("In Progress", "dana", "2026-10-02T00:00:00Z"),
    ]);
    expect((await poolReads(on([], events).t).movedBy("#5")).name).toBe("dana");
  });

  it("names the author of an issue opened in the state that carries none", async () => {
    const { t } = on([], timeline([], false, "dana"));
    expect(await poolReads(t).movedBy("#5")).toEqual({
      id: "dana",
      name: "dana",
      trusted: true,
    });
    const { t: cut } = on([], timeline([], true, "dana"));
    await expect(poolReads(cut).movedBy("#5")).rejects.toThrow(
      "beyond the last 100 events",
    );
  });

  it("throws when no event moved the issue there, or the mover's account is gone", async () => {
    const { t } = on(["Backlog"], timeline([]));
    await expect(poolReads(t).movedBy("#5")).rejects.toThrow(
      "no event moved it into Backlog",
    );
    const { t: gone } = on(
      ["Backlog"],
      timeline([labelled("Backlog", null, "2026-10-02T00:00:00Z")]),
    );
    await expect(poolReads(gone).movedBy("#5")).rejects.toThrow(
      "names no actor",
    );
  });

  it("on a board, names who set the status option, and never trusts a project workflow", async () => {
    const status = (actor: string, automated: boolean) =>
      timeline([
        {
          __typename: "ProjectV2ItemStatusChangedEvent",
          createdAt: "2026-10-02T00:00:00Z",
          actor: { login: actor },
          status: "Todo",
          wasAutomated: automated,
          project: { url: "https://github.com/orgs/acme/projects/7" },
        },
      ]);
    const board = (events: ReturnType<typeof timeline>) =>
      gitHub((c) => {
        if (c.op === "TrackerIssue")
          return oneIssue(issueNode({ number: 5, status: "Todo", extra: SUB }));
        if (c.op === "TrackerStateChanges") return events;
        if (c.op === "TrackerCollaborator") return collaborator("WRITE");
        throw new Error(`unexpected ${c.op}`);
      }, ON_BOARD).t;
    expect(
      (await poolReads(board(status("dana", false))).movedBy("#5")).trusted,
    ).toBe(true);
    expect(await poolReads(board(status("dana", true))).movedBy("#5")).toEqual({
      id: "dana",
      name: "a project workflow (as dana)",
      trusted: false,
    });
  });
});

describe("Linear adapter: ready-pool reads", () => {
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
  function tracker(answer: (variables: Record<string, unknown>) => unknown) {
    const calls: Array<Record<string, unknown>> = [];
    const transport: LinearTransport = async (_query, variables) => {
      calls.push(variables);
      return answer(variables);
    };
    return {
      read: poolReads(
        linearTracker({ team: "ENG", states: STATES, transport }),
      ),
      calls,
    };
  }
  const history = (
    entries: Array<{ to: string; actor: unknown; at: string }>,
    creator: unknown = member,
  ) => ({
    issue: {
      state: { id: "s-todo", name: "Todo" },
      creator,
      history: page(
        entries.map((e, i) => ({
          id: `h${i}`,
          createdAt: e.at,
          toState: { id: e.to },
          actor: e.actor,
        })),
      ),
    },
  });

  it("filters by team, no assignee and the states' names", async () => {
    const { read, calls } = tracker(() => ({
      issues: page([
        {
          identifier: "ENG-4",
          title: "t",
          url: null,
          priority: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          state: { id: "s-todo", name: "Todo", type: "unstarted" },
          assignee: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: [] },
          children: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      ]),
    }));
    const got = await read.unassigned(["todo"]);
    expect(got.map((i) => i.identifier)).toEqual(["ENG-4"]);
    expect(calls[0]?.filter).toEqual({
      and: [
        { team: { key: { eq: "ENG" } } },
        {
          and: [
            { assignee: { null: true } },
            {
              state: { type: { nin: ["completed", "canceled", "duplicate"] } },
            },
          ],
        },
        { state: { name: { in: ["Todo"] } } },
      ],
    });
  });

  it("names the newest mover into the issue's state, trusted as a non-guest team member", async () => {
    const { read } = tracker(() =>
      history([
        {
          to: "s-todo",
          actor: { ...member, id: "u-old", name: "Old" },
          at: "2026-10-01T00:00:00Z",
        },
        { to: "s-todo", actor: member, at: "2026-10-02T00:00:00Z" },
        {
          to: "s-ip",
          actor: { ...member, id: "u-x", name: "X" },
          at: "2026-10-03T00:00:00Z",
        },
      ]),
    );
    expect(await read.movedBy("ENG-4")).toEqual({
      id: "u-d",
      name: "Dana",
      trusted: true,
    });
    const { read: guest } = tracker(() =>
      history([
        {
          to: "s-todo",
          actor: { ...member, guest: true },
          at: "2026-10-02T00:00:00Z",
        },
      ]),
    );
    expect((await guest.movedBy("ENG-4")).trusted).toBe(false);
  });

  it("reads an automation's move as untrusted, and an issue created in the state as its creator's", async () => {
    const { read: automation } = tracker(() =>
      history([{ to: "s-todo", actor: null, at: "2026-10-02T00:00:00Z" }]),
    );
    expect(await automation.movedBy("ENG-4")).toEqual({
      id: "",
      name: "an integration or an automation",
      trusted: false,
    });
    const { read: created } = tracker(() => history([]));
    expect((await created.movedBy("ENG-4")).name).toBe("Dana");
    const { read: outsider } = tracker(() =>
      history([], { ...member, teams: { nodes: [] } }),
    );
    expect((await outsider.movedBy("ENG-4")).trusted).toBe(false);
  });
});

describe("Jira adapter: ready-pool reads", () => {
  const changelog = (
    entries: Array<{ author: unknown; to: string; at: string }>,
  ) => ({
    values: entries.map((e, i) => ({
      id: String(i + 1),
      author: e.author ?? undefined,
      created: e.at,
      items: [
        { field: "status", fieldId: "status", from: "s-Backlog", to: e.to },
      ],
    })),
    startAt: 0,
    maxResults: 100,
    total: entries.length,
    isLast: true,
  });
  const on = (log: ReturnType<typeof changelog>, creator: unknown = MEMBER) =>
    jira(
      routes({
        "GET issue/ENG-7": (c: Call) =>
          c.query.fields === "creator"
            ? { key: "ENG-7", fields: { creator } }
            : jiraIssue({ key: "ENG-7", status: "Todo" }),
        "GET issue/ENG-7/changelog": log,
        "GET user/assignable/search": assignable(MEMBER.accountId),
      }),
    );

  it("searches the project's unassigned issues in the asked states", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": jiraPage(
          jiraIssue({ key: "ENG-7", status: "Todo" }),
        ),
      }),
    );
    const got = await poolReads(t).unassigned(["todo"]);
    expect(got.map((i) => i.identifier)).toEqual(["ENG-7"]);
    const jql = jqlOf(calls.find((c) => c.route === "POST search/jql") as Call);
    expect(jql).toContain("assignee is EMPTY");
    expect(jql).toContain('status in ("Todo")');
  });

  it("names the author of the newest move into the issue's status, never trusting an app", async () => {
    const moves = (author: unknown) =>
      changelog([
        { author: APP, to: "s-Todo", at: "2026-01-01T00:00:00.000+0000" },
        { author, to: "s-Todo", at: "2026-01-02T00:00:00.000+0000" },
        { author: APP, to: "s-Done", at: "2026-01-03T00:00:00.000+0000" },
      ]);
    expect(await poolReads(on(moves(MEMBER)).t).movedBy("ENG-7")).toEqual({
      id: MEMBER.accountId,
      name: "Dana Lee",
      trusted: true,
    });
    expect(await poolReads(on(moves(APP)).t).movedBy("ENG-7")).toEqual({
      id: APP.accountId,
      name: "Automation for Jira",
      trusted: false,
    });
    expect((await poolReads(on(moves(null)).t).movedBy("ENG-7")).trusted).toBe(
      false,
    );
  });

  it("names the creator of an issue created in its status", async () => {
    expect((await poolReads(on(changelog([])).t).movedBy("ENG-7")).name).toBe(
      "Dana Lee",
    );
    expect(
      (await poolReads(on(changelog([]), APP).t).movedBy("ENG-7")).trusted,
    ).toBe(false);
  });
});
