/**
 * The ready pool (`dispatch.pool`): unassigned items in its states picked up
 * as the factory identity's, trusted by who made them ready. The section is
 * refused without the claim marker; on each adapter, through its fake
 * transport, an item a person with write access made ready is planned by
 * two hosts and claimed once, the claim marker deciding between them, and
 * an item an account without write access made ready is never planned.
 */
import { describe, expect, it } from "bun:test";
import type { Clock } from "../../shared/clock.ts";
import { claimIssue } from "../../skills/do-item/scripts/lib/claim.ts";
import { claimWithMarker } from "../../skills/do-item/scripts/lib/claim-token.ts";
import { parseTrackerConfig } from "../../skills/do-item/scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../../skills/do-item/scripts/lib/tracker/linear.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import {
  assignable,
  type Call,
  FACTORY,
  issue as jiraIssue,
  jira,
  jqlOf,
  MEMBER,
  page,
} from "../../skills/do-item/__tests__/jira-fixtures.ts";
import { dispatchSection } from "../lib/section.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { readPoolPickups } from "../lib/sources/ready-pool.ts";
import { freshPickup, readPickups } from "../lib/sources/tracker.ts";
import type { DispatchSection } from "../lib/types.ts";

/** No waits between the marker's read-backs. */
const CLOCK: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };
const FACTS = { session: "s", branch: "b", claimant: "factory" };

/** The section of a repository whose pool is `todo`, for `identity`. */
function poolSection(identity: string): DispatchSection {
  const parsed = dispatchSection({
    dispatch: { identity, pool: { states: ["todo"] } },
    do_item: { claim_marker: true },
  });
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  return parsed.value;
}

describe("dispatch.pool", () => {
  const sectionOf = (values: Record<string, unknown>) =>
    dispatchSection(values);
  const refusal = (values: Record<string, unknown>) => {
    const parsed = sectionOf(values);
    return parsed.ok ? null : parsed.failure.reason;
  };

  it("reads the pool's states, and none when it is unset", () => {
    const set = sectionOf({
      dispatch: { identity: "factory", pool: { states: ["todo", "backlog"] } },
      do_item: { claim_marker: true },
    });
    expect(set.ok && set.value.pool).toEqual({ states: ["todo", "backlog"] });
    const unset = sectionOf({ dispatch: { identity: "factory" } });
    expect(unset.ok && "pool" in unset.value).toBe(false);
  });

  it("is refused without do_item.claim_marker", () => {
    for (const do_item of [undefined, {}, { claim_marker: false }])
      expect(
        refusal({
          dispatch: { identity: "factory", pool: { states: ["todo"] } },
          ...(do_item === undefined ? {} : { do_item }),
        }),
      ).toContain("dispatch.pool needs do_item.claim_marker");
  });

  it("is refused without the factory identity, states it cannot take, or a key it does not know", () => {
    const marker = { do_item: { claim_marker: true } };
    expect(
      refusal({ dispatch: { pool: { states: ["todo"] } }, ...marker }),
    ).toContain("dispatch.pool needs dispatch.identity");
    expect(
      refusal({
        dispatch: { identity: "f", pool: { states: ["in_progress"] } },
        ...marker,
      }),
    ).toContain("dispatch.pool.states cannot list in_progress");
    expect(
      refusal({ dispatch: { identity: "f", pool: {} }, ...marker }),
    ).toContain("dispatch.pool.states must name");
    expect(
      refusal({
        dispatch: { identity: "f", pool: { states: ["todo"], size: 3 } },
        ...marker,
      }),
    ).toContain("dispatch.pool has unknown key(s): size");
  });
});

/**
 * Two hosts each read the pool, re-read the item before the launch, and
 * claim it with the claim marker at once; the outcomes, sorted.
 */
async function twoHosts(
  make: () => Tracker,
  section: DispatchSection,
  key: string,
): Promise<string[]> {
  const planned = await Promise.all([
    readPickups(make, section),
    readPickups(make, section),
  ]);
  for (const reading of planned) {
    expect(reading.unplaced).toEqual([]);
    expect(reading.wanted.map((w) => [w.key, w.pooled])).toEqual([[key, true]]);
  }
  for (const _ of planned) {
    const fresh = await freshPickup(make(), section, key);
    expect(typeof fresh === "string" ? fresh : fresh.identifier).toBe(key);
  }
  const claim = () => {
    const t = make();
    return claimWithMarker(t, key, FACTS, () => claimIssue(t, key), CLOCK);
  };
  return (await Promise.all([claim(), claim()])).map((r) => r.outcome).sort();
}

describe("a pool pickup across two hosts", () => {
  it("on GitHub", async () => {
    const item = { labels: [] as string[], logins: [] as string[] };
    const comments: Array<Record<string, unknown>> = [];
    const writes: string[] = [];
    let n = 0;
    let author = "dana";
    const user = (login: string) => ({ id: `U_${login}`, login });
    const node = () =>
      issueNode({
        number: 5,
        labels: item.labels,
        assignee: item.logins[0] ?? null,
        extra: { subIssues: conn([]), author: { login: author } },
      });
    const make = () =>
      gitHub((c) => {
        switch (c.op) {
          case "TrackerIssues": {
            const by = (c.variables.filterBy as Record<string, unknown>)
              .assignee;
            const mine = by === undefined || item.logins.includes(String(by));
            return { repository: { issues: conn(mine ? [node()] : []) } };
          }
          case "TrackerIssue":
            return oneIssue(node());
          case "TrackerStateChanges":
            return {
              repository: {
                issue: {
                  author: { login: author },
                  timelineItems: {
                    pageInfo: { hasPreviousPage: false },
                    nodes: [],
                  },
                },
              },
            };
          case "TrackerCollaborator":
            return {
              repository: {
                collaborators: {
                  edges: [
                    { permission: "WRITE", node: { login: "dana" } },
                    { permission: "READ", node: { login: "outsider" } },
                  ],
                },
              },
            };
          case "TrackerViewer":
            return { viewer: user("factory") };
          case "TrackerAssignees":
            return {
              repository: {
                issue: {
                  id: "I_5",
                  assignees: {
                    totalCount: item.logins.length,
                    nodes: item.logins.map(user),
                  },
                },
              },
            };
          case "TrackerLabels":
            return {
              repository: {
                labels: conn([{ id: "LA_ip", name: "In Progress" }]),
              },
            };
          case "TrackerAssign":
            writes.push(c.op);
            item.logins = ["factory"];
            return { updateIssue: { issue: { id: "I_5" } } };
          case "TrackerAddLabels":
            writes.push(c.op);
            item.labels = ["In Progress"];
            return { addLabelsToLabelable: { clientMutationId: null } };
          case "TrackerComment":
            n++;
            comments.push({
              id: `IC_${n}`,
              body: String(c.variables.body),
              createdAt: new Date().toISOString(),
              authorAssociation: "MEMBER",
              viewerDidAuthor: true,
            });
            return { addComment: { clientMutationId: null } };
          case "TrackerComments":
            return {
              repository: { issue: { id: "I_5", comments: conn(comments) } },
            };
          case "TrackerDeleteComment": {
            const at = comments.findIndex((m) => m.id === c.variables.id);
            if (at >= 0) comments.splice(at, 1);
            return { deleteIssueComment: { clientMutationId: null } };
          }
          default:
            throw new Error(`unexpected ${c.op}`);
        }
      }).t;
    const section = poolSection("factory");
    author = "outsider";
    const untrusted = await readPickups(make, section);
    expect(untrusted.wanted).toEqual([]);
    expect(untrusted.unplaced.map((u) => [u.target, u.reason])).toEqual([
      [
        "#5",
        "moved to Todo by outsider, who cannot write to acme/app; only an item a person with write access made ready is picked up from the pool",
      ],
    ]);
    author = "dana";
    expect(await twoHosts(make, section, "#5")).toEqual(["claimed", "refused"]);
    expect(writes).toEqual(["TrackerAssign", "TrackerAddLabels"]);
    expect(comments).toHaveLength(1);
  });

  it("on Linear", async () => {
    const ME = { id: "u-me", name: "factory" };
    const item = { stateName: "Todo", assignee: null as typeof ME | null };
    const comments: Array<Record<string, unknown>> = [];
    const writes: string[] = [];
    let n = 0;
    let mover: Record<string, unknown> = {
      id: "u-d",
      name: "Dana",
      guest: false,
      teams: { nodes: [{ key: "ENG" }] },
    };
    const STATE_IDS: Record<string, string> = {
      Todo: "s-todo",
      "In Progress": "s-ip",
    };
    const poolNode = () => ({
      identifier: "ENG-4",
      title: "t",
      url: null,
      priority: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      state: {
        id: STATE_IDS[item.stateName],
        name: item.stateName,
        type: "unstarted",
      },
      assignee: item.assignee,
      labels: { pageInfo: { hasNextPage: false }, nodes: [] },
      children: { pageInfo: { hasNextPage: false }, nodes: [] },
    });
    const none = { pageInfo: { hasNextPage: false, endCursor: null } };
    const transport: LinearTransport = async (query, variables) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      switch (op) {
        case "TrackerPool": {
          const clauses = (variables.filter as { and: unknown[] }).and;
          const unassigned = clauses.some(
            (c) => JSON.stringify(c) === '{"assignee":{"null":true}}',
          );
          const named = JSON.stringify(clauses.at(-1));
          const listed =
            unassigned === (item.assignee === null) &&
            named.includes(`"${item.stateName}"`);
          return { issues: { ...none, nodes: listed ? [poolNode()] : [] } };
        }
        case "TrackerStateHistory":
          return {
            issue: {
              state: { id: STATE_IDS[item.stateName], name: item.stateName },
              creator: mover,
              history: { ...none, nodes: [] },
            },
          };
        case "TrackerViewer":
          return { viewer: ME };
        case "TrackerAssignee":
          return { issue: { id: "uuid-4", assignee: item.assignee } };
        case "TrackerPoolIssue":
          return { issue: poolNode() };
        case "TrackerAssign":
          writes.push(op);
          item.assignee = ME;
          return { issueUpdate: { success: true } };
        case "TrackerIssueId":
          return { issue: { id: "uuid-4", team: { id: "t-1", key: "ENG" } } };
        case "TrackerStates":
          return {
            team: {
              states: {
                ...none,
                nodes: Object.entries(STATE_IDS).map(([name, id]) => ({
                  id,
                  name,
                  type: "unstarted",
                })),
              },
            },
          };
        case "TrackerUpdate":
          writes.push(op);
          item.stateName = "In Progress";
          return { issueUpdate: { success: true } };
        case "TrackerComment":
          n++;
          comments.push({
            id: `c-${n}`,
            body: String(variables.body),
            createdAt: new Date(Date.now() + n).toISOString(),
            user: { id: ME.id, guest: false },
          });
          return { commentCreate: { success: true } };
        case "TrackerComments":
          return {
            issue: { id: "uuid-4", comments: { ...none, nodes: comments } },
          };
        case "TrackerDeleteComment": {
          const at = comments.findIndex((m) => m.id === variables.id);
          if (at >= 0) comments.splice(at, 1);
          return { commentDelete: { success: true } };
        }
        default:
          throw new Error(`unexpected ${op}`);
      }
    };
    const make = () =>
      linearTracker({
        team: "ENG",
        states: parseTrackerConfig({}).states,
        transport,
      });
    const section = poolSection("factory@example.invalid");
    const trusted = mover;
    mover = { ...trusted, name: "Guest", guest: true };
    const untrusted = await readPickups(make, section);
    expect(untrusted.wanted).toEqual([]);
    expect(untrusted.unplaced[0]?.reason).toContain("moved to Todo by Guest");
    mover = trusted;
    expect(await twoHosts(make, section, "ENG-4")).toEqual([
      "claimed",
      "refused",
    ]);
    expect(writes).toEqual(["TrackerAssign", "TrackerUpdate"]);
    expect(comments).toHaveLength(1);
  });

  it("on Jira", async () => {
    const item = {
      status: "Todo",
      category: "new" as "new" | "indeterminate",
      assignee: null as typeof FACTORY | null,
    };
    const comments: Array<Record<string, unknown>> = [];
    const writes: string[] = [];
    let n = 0;
    let mover: Record<string, unknown> = MEMBER;
    const answer = (c: Call) => {
      if (c.route === "GET myself") return { ...FACTORY, timeZone: "UTC" };
      if (c.route === "GET user") return FACTORY;
      if (c.route === "GET issue/ENG-1")
        return c.query.fields === "creator"
          ? { key: "ENG-1", fields: { creator: MEMBER } }
          : jiraIssue({ key: "ENG-1", ...item });
      if (c.route === "GET issue/ENG-1/changelog")
        return {
          values: [
            {
              id: "1",
              author: mover,
              created: "2026-01-02T00:00:00.000+0000",
              items: [
                {
                  field: "status",
                  fieldId: "status",
                  from: "s-Backlog",
                  to: "s-Todo",
                },
              ],
            },
          ],
          startAt: 0,
          maxResults: 100,
          total: 1,
          isLast: true,
        };
      if (c.route === "POST search/jql") {
        const jql = jqlOf(c);
        const listed =
          jql.includes("assignee is EMPTY") &&
          item.assignee === null &&
          jql.includes(`"${item.status}"`);
        return listed ? page(jiraIssue({ key: "ENG-1", ...item })) : page();
      }
      if (c.route === "PUT issue/ENG-1/assignee") {
        writes.push(c.route);
        item.assignee = FACTORY;
        return null;
      }
      if (c.route === "GET issue/ENG-1/transitions")
        return {
          transitions: [
            {
              id: "11",
              name: "to In Progress",
              to: {
                id: "s-InProgress",
                name: "In Progress",
                statusCategory: { key: "indeterminate" },
              },
              fields: {},
            },
          ],
        };
      if (c.route === "POST issue/ENG-1/transitions") {
        writes.push(c.route);
        item.status = "In Progress";
        item.category = "indeterminate";
        return null;
      }
      if (c.route === "GET user/assignable/search")
        return assignable(FACTORY.accountId, MEMBER.accountId)(c);
      if (c.route === "POST issue/ENG-1/comment") {
        n++;
        comments.push({
          id: String(1000 + n),
          author: FACTORY,
          body: c.body.body,
          created: new Date().toISOString().replace("Z", "+0000"),
        });
        return { id: String(1000 + n) };
      }
      if (c.route === "GET issue/ENG-1/comment")
        return {
          comments,
          startAt: 0,
          maxResults: 100,
          total: comments.length,
        };
      const del = /^DELETE issue\/ENG-1\/comment\/(\d+)$/.exec(c.route);
      if (del) {
        const at = comments.findIndex((m) => m.id === del[1]);
        if (at >= 0) comments.splice(at, 1);
        return null;
      }
      return new Error(`unexpected request ${c.route}`);
    };
    const make = () => jira(answer).t;
    const section = poolSection(FACTORY.accountId);
    mover = {
      accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077",
      displayName: "Automation for Jira",
      accountType: "app",
    };
    const untrusted = await readPickups(make, section);
    expect(untrusted.wanted).toEqual([]);
    expect(untrusted.unplaced[0]?.reason).toContain(
      "moved to Todo by Automation for Jira",
    );
    mover = MEMBER;
    expect(await twoHosts(make, section, "ENG-1")).toEqual([
      "claimed",
      "refused",
    ]);
    expect(writes).toEqual([
      "PUT issue/ENG-1/assignee",
      "POST issue/ENG-1/transitions",
    ]);
    expect(comments).toHaveLength(1);
  });
});

describe("who made a pool item ready", () => {
  it("is read once per change to the item, kept between readings", async () => {
    const kept = new Map<string, unknown>();
    const cache: PickupReads = {
      get: <T>(key: string) => (kept.get(key) as T | undefined) ?? null,
      set: (key, value) => void kept.set(key, value),
    };
    const issue: PoolIssue = {
      identifier: "ENG-9",
      title: "t",
      url: null,
      priority: 0,
      type: null,
      size: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
      assignee: null,
      labels: [],
      hasOpenChildren: false,
      truncated: [],
    };
    let current = issue;
    const reads: string[] = [];
    const tracker = {
      adapter: "linear",
      team: "ENG",
      stateName: (s: string) => (s === "todo" ? "Todo" : null),
      unassignedIssues: async () => [current],
      stateChangedBy: async (key: string) => {
        reads.push(key);
        return { id: "u-d", name: "Dana", trusted: true };
      },
    } as unknown as Tracker;
    const section = poolSection("factory@example.invalid");
    const wanted = async () =>
      (await readPoolPickups(tracker, section, {}, cache)).wanted.map(
        (w) => w.key,
      );
    expect(await wanted()).toEqual(["ENG-9"]);
    expect(await wanted()).toEqual(["ENG-9"]);
    expect(reads).toEqual(["ENG-9"]);
    current = { ...issue, updatedAt: "2026-10-02T00:00:00.000Z" };
    expect(await wanted()).toEqual(["ENG-9"]);
    expect(reads).toEqual(["ENG-9", "ENG-9"]);
  });
});
