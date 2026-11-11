/**
 * Claims across hosts: the claim marker as the claim's token
 * (`claim-token.ts`). Two hosts claiming one item with the same identity
 * write the same assignee and state, so only the markers tell them apart:
 * of the markers on the item the earliest wins, the other claim refuses
 * with nothing written to the item. Over an in-memory comment store, then
 * two hosts racing over each adapter's fake transport.
 */
import { describe, expect, it } from "bun:test";
import type { Clock } from "../../../shared/clock.ts";
import { type ClaimResult, claimIssue } from "../scripts/lib/claim.ts";
import {
  claimMarkerBody,
  readClaimMarker,
} from "../scripts/lib/claim-marker.ts";
import {
  CLAIM_LAPSE_MS,
  claimWithMarker,
  type TokenTracker,
} from "../scripts/lib/claim-token.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import type { CommentFact, Tracker } from "../scripts/lib/tracker/port.ts";
import { conn, gitHub, issueNode, oneIssue } from "./github-fixtures.ts";
import {
  assignable,
  type Call,
  FACTORY,
  issue as jiraIssue,
  jira,
  MEMBER,
  page,
} from "./jira-fixtures.ts";

const STATES = parseTrackerConfig({}).states;
/** No waits between read-backs. */
const CLOCK: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };
const FACTS = { session: "s", branch: "b", claimant: "factory" };

/** A marker another claim posted, `ago` milliseconds before now. */
function theirs(id: string, ago: number, trusted = true): CommentFact {
  return {
    id,
    trusted,
    createdAt: new Date(Date.now() - ago).toISOString(),
    body: claimMarkerBody({
      attempt: `other-${id}`,
      ...FACTS,
      at: new Date().toISOString(),
    }),
  };
}

/** One item's comments, shared by every host that reads it. */
function store(initial: CommentFact[] = []) {
  const comments = [...initial];
  let n = 0;
  const log: string[] = [];
  const tracker = (
    overrides: Partial<TokenTracker> = {},
  ): TokenTracker & { log: string[] } => ({
    log,
    issueComments: async () => ({ uuid: "u", comments: [...comments] }),
    postComment: async (_key, body) => {
      n++;
      log.push("post");
      comments.push({
        id: `c${n}`,
        body,
        createdAt: new Date().toISOString(),
        trusted: true,
      });
    },
    deleteComment: async (_key, id) => {
      log.push(`delete ${id}`);
      const at = comments.findIndex((c) => c.id === id);
      if (at >= 0) comments.splice(at, 1);
    },
    ...overrides,
  });
  return { comments, tracker, log };
}

const claimed = (): Promise<ClaimResult> =>
  Promise.resolve({
    outcome: "claimed",
    issue: "#5",
    claimant: { id: "u", name: "factory" },
    state: "In Progress",
  });

describe("the claim marker as the claim's token", () => {
  it("of two claims at once, the earlier marker wins and the other refuses, withdrawing its own", async () => {
    const s = store();
    let claims = 0;
    const body = () => {
      claims++;
      return claimed();
    };
    const [a, b] = await Promise.all([
      claimWithMarker(s.tracker(), "#5", FACTS, body, CLOCK),
      claimWithMarker(s.tracker(), "#5", FACTS, body, CLOCK),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["claimed", "refused"]);
    const lost = a.outcome === "refused" ? a : b;
    expect(lost).toMatchObject({ why: "marker" });
    expect(claims).toBe(1);
    // Only the winner's marker is left.
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0]?.id).toBe("c1");
  });

  it("claims, and reports the marker confirmed, when its marker is the earliest", async () => {
    const s = store();
    const out = await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK);
    expect(out).toMatchObject({
      outcome: "claimed",
      marker: { posted: true, confirmed: true },
    });
    expect(readClaimMarker(s.comments[0]?.body ?? "")).toMatchObject(FACTS);
  });

  it("refuses, running no claim, when a live marker is earlier", async () => {
    const s = store([theirs("x", 60_000)]);
    let ran = false;
    const out = await claimWithMarker(
      s.tracker(),
      "#5",
      FACTS,
      () => {
        ran = true;
        return claimed();
      },
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    expect(ran).toBe(false);
    expect(s.comments.map((c) => c.id)).toEqual(["x"]);
  });

  it("ignores a marker older than the lapse window", async () => {
    const s = store([theirs("x", CLAIM_LAPSE_MS + 60_000)]);
    expect(
      (await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK)).outcome,
    ).toBe("claimed");
  });

  it("ignores an earlier marker from an untrusted author", async () => {
    const s = store([theirs("x", 1_000, false)]);
    expect(
      (await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK)).outcome,
    ).toBe("claimed");
  });

  it("refuses, writing nothing, when its marker cannot be posted", async () => {
    const s = store();
    let ran = false;
    const out = await claimWithMarker(
      s.tracker({
        postComment: async () => {
          throw new Error("the tracker is down");
        },
      }),
      "#5",
      FACTS,
      () => {
        ran = true;
        return claimed();
      },
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    expect(out.outcome === "refused" && out.reason).toContain(
      "could not be posted",
    );
    expect(ran).toBe(false);
  });

  it("refuses, writing nothing, when its marker cannot be read back", async () => {
    const s = store();
    let ran = false;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          throw new Error("unreadable");
        },
      }),
      "#5",
      FACTS,
      () => {
        ran = true;
        return claimed();
      },
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    expect(out.outcome === "refused" && out.reason).toContain(
      "could not be read back",
    );
    expect(ran).toBe(false);
  });

  it("refuses when its own marker never shows among the trusted comments", async () => {
    const s = store();
    let reads = 0;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          return { uuid: "u", comments: [] };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    expect(reads).toBe(3);
  });

  it("stands down when an earlier marker shows only after the claim wrote", async () => {
    // The other host's marker is earlier, but the first listing lags past it.
    const s = store();
    const late = theirs("x", 1_000);
    let reads = 0;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          return {
            uuid: "u",
            comments: reads === 1 ? [...s.comments] : [late, ...s.comments],
          };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "stood_down" });
    expect(s.log).toEqual(["post", "delete c1"]);
  });

  it("withdraws its marker when the claim itself refuses", async () => {
    const s = store();
    const out = await claimWithMarker(
      s.tracker(),
      "#5",
      FACTS,
      async () => ({
        outcome: "refused",
        issue: "#5",
        why: "in_progress",
        reason: "held",
      }),
      CLOCK,
    );
    expect(out.outcome).toBe("refused");
    expect(s.comments).toEqual([]);
  });

  it("keeps a claim whose read after the write fails, saying the marker is unconfirmed", async () => {
    const s = store();
    let reads = 0;
    const base = s.tracker();
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async (key) => {
          reads++;
          if (reads > 1) throw new Error("unreadable");
          return base.issueComments(key);
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({
      outcome: "claimed",
      marker: { posted: true, confirmed: false, reason: "unreadable" },
    });
  });
});

/** Two hosts claim one item at once through `make`'s adapter; exactly one claims it. */
async function race(make: () => Tracker, key: string) {
  const host = () => {
    const t = make();
    return claimWithMarker(t, key, FACTS, () => claimIssue(t, key), CLOCK);
  };
  const results = await Promise.all([host(), host()]);
  return results.map((r) => r.outcome).sort();
}

describe("two hosts racing for one item", () => {
  it("on GitHub", async () => {
    const item = { labels: [] as string[], logins: [] as string[] };
    const comments: Array<Record<string, unknown>> = [];
    const writes: string[] = [];
    let n = 0;
    const user = (login: string) => ({ id: `U_${login}`, login });
    const make = () =>
      gitHub((c) => {
        switch (c.op) {
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
          case "TrackerIssue":
            return oneIssue(
              issueNode({
                number: 5,
                labels: item.labels,
                assignee: item.logins[0] ?? null,
                extra: { subIssues: conn([]) },
              }),
            );
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
    expect(await race(make, "#5")).toEqual(["claimed", "refused"]);
    expect(writes).toEqual(["TrackerAssign", "TrackerAddLabels"]);
    expect(comments).toHaveLength(1);
  });

  it("on Linear", async () => {
    const ME = { id: "u-me", name: "factory" };
    const item = { stateName: "Todo", assignee: null as typeof ME | null };
    const comments: Array<Record<string, unknown>> = [];
    const writes: string[] = [];
    let n = 0;
    const STATE_IDS: Record<string, string> = {
      Todo: "s-todo",
      "In Progress": "s-ip",
    };
    const transport: LinearTransport = async (query, variables) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      switch (op) {
        case "TrackerViewer":
          return { viewer: ME };
        case "TrackerAssignee":
          return { issue: { id: "uuid-4", assignee: item.assignee } };
        case "TrackerPoolIssue":
          return {
            issue: {
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
            },
          };
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
                pageInfo: { hasNextPage: false },
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
            issue: {
              id: "uuid-4",
              comments: { pageInfo: { hasNextPage: false }, nodes: comments },
            },
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
      linearTracker({ team: "ENG", states: STATES, transport });
    expect(await race(make, "ENG-4")).toEqual(["claimed", "refused"]);
    expect(writes).toEqual(["TrackerAssign", "TrackerUpdate"]);
    expect(comments).toHaveLength(1);
  });

  it("on Jira", async () => {
    const item = {
      status: "To Do",
      category: "new" as "new" | "indeterminate",
      assignee: null as typeof FACTORY | null,
    };
    const comments: Array<Record<string, unknown>> = [];
    const writes: string[] = [];
    let n = 0;
    const answer = (c: Call) => {
      if (c.route === "GET myself") return FACTORY;
      if (c.route === "GET issue/ENG-1")
        return jiraIssue({ key: "ENG-1", ...item });
      if (c.route === "POST search/jql") return page();
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
    expect(await race(make, "ENG-1")).toEqual(["claimed", "refused"]);
    expect(writes).toEqual([
      "PUT issue/ENG-1/assignee",
      "POST issue/ENG-1/transitions",
    ]);
    expect(comments).toHaveLength(1);
  });
});
