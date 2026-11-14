/**
 * The ready pool (`dispatch.pool`): unassigned items in its states picked up
 * as the factory identity's, trusted by who made them ready. The section is
 * refused without the claim marker; on each adapter, through its fake
 * transport, an item a person with write access made ready is planned by
 * two hosts and claimed once, the claim marker deciding between them; an
 * item an account without write access made ready is never planned, and one
 * with an open blocker waits, named in the queue, until the blocker closes.
 */
import { describe, expect, it } from "bun:test";
import type { Clock } from "../../shared/clock.ts";
import { claimIssue } from "../../skills/do-item/scripts/lib/claim.ts";
import {
  readClaimMarker,
  readClaimOutcome,
} from "../../skills/do-item/scripts/lib/claim-marker.ts";
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
  githubClaimStore,
  jiraClaimStore,
  linearClaimStore,
} from "../../skills/do-item/__tests__/claim-fakes.ts";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import {
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
import { freshPoolPickup, readPoolPickups } from "../lib/sources/ready-pool.ts";
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

/** The claim markers left on the item and the outcomes recorded, read back as a claim reads them. */
async function claimComments(t: Tracker, key: string) {
  const { comments } = await t.issueComments(key);
  return {
    markers: comments.filter((c) => readClaimMarker(c.body) !== null).length,
    outcomes: comments
      .flatMap((c) => readClaimOutcome(c.body)?.outcome ?? [])
      .sort(),
  };
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

/**
 * While `blocker` is open the item is not planned, the queue says it waits
 * on it, and its launch is refused; `close` closes the blocker.
 */
async function waitsOn(
  make: () => Tracker,
  section: DispatchSection,
  key: string,
  blocker: string,
): Promise<void> {
  const held = await readPickups(make, section);
  expect(held.wanted).toEqual([]);
  expect(held.unplaced.map((u) => [u.target, u.reason])).toEqual([
    [key, `in the ready pool (Todo), but waiting on ${blocker}`],
  ]);
  expect(await freshPoolPickup(make(), section, key)).toBe(
    `waiting on ${blocker}`,
  );
}

describe("a pool pickup across two hosts", () => {
  it("on GitHub", async () => {
    const s = githubClaimStore();
    const { item, user } = s;
    let author = "dana";
    let blockerOpen = true;
    const relations = (blockedBy: number[]) => ({
      blockedBy: conn(
        blockedBy.map((number) => ({
          number,
          repository: { nameWithOwner: "acme/app" },
        })),
      ),
      blocking: conn([]),
      relatesTo: conn([]),
      duplicateOf: null,
      timelineItems: conn([]),
    });
    const node = () =>
      issueNode({
        number: 5,
        labels: item.labels,
        assignee: item.logins[0] ?? null,
        extra: {
          subIssues: conn([]),
          author: { login: author },
          ...relations([6]),
        },
      });
    const blocker = () =>
      issueNode({
        number: 6,
        state: blockerOpen ? "OPEN" : "CLOSED",
        extra: { subIssues: conn([]), ...relations([]) },
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
            return oneIssue(c.variables.number === 6 ? blocker() : node());
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
          case "TrackerUser":
            return { user: user("factory") };
          default:
            return s.answer(c);
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
    await waitsOn(make, section, "#5", "#6");
    blockerOpen = false;
    expect(await twoHosts(make, section, "#5")).toEqual(["claimed", "refused"]);
    expect(s.writes).toEqual(["TrackerAssign", "TrackerAddLabels"]);
    expect(await claimComments(make(), "#5")).toEqual({
      markers: 1,
      outcomes: ["claimed", "released"],
    });
  });

  it("on Linear", async () => {
    const s = linearClaimStore("Todo");
    const { ME, item, STATE_IDS, none } = s;
    let mover: Record<string, unknown> = {
      id: "u-d",
      name: "Dana",
      guest: false,
      teams: { nodes: [{ key: "ENG" }] },
    };
    let blockerType = "started";
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
    const transport: LinearTransport = async (query, variables) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      switch (op) {
        case "TrackerPool": {
          const clauses = (variables.filter as { and: unknown[] }).and;
          const unassigned = clauses.some((c) =>
            JSON.stringify(c).includes('"assignee":{"null":true}'),
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
        case "TrackerUsers":
          return { users: { nodes: [ME] } };
        case "TrackerPoolIssue":
          return variables.id === "ENG-5"
            ? {
                issue: {
                  ...poolNode(),
                  identifier: "ENG-5",
                  state: { id: "s-x", name: "Blocker", type: blockerType },
                },
              }
            : { issue: poolNode() };
        case "TrackerRelations":
          return { issue: { relations: { ...none, nodes: [] } } };
        case "TrackerInverseRelations":
          return {
            issue: {
              inverseRelations: {
                ...none,
                nodes: [
                  { id: "r-1", type: "blocks", issue: { identifier: "ENG-5" } },
                ],
              },
            },
          };
        default:
          return s.answer(op, variables);
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
    await waitsOn(make, section, "ENG-4", "ENG-5");
    blockerType = "completed";
    expect(await twoHosts(make, section, "ENG-4")).toEqual([
      "claimed",
      "refused",
    ]);
    expect(s.writes).toEqual(["TrackerAssign", "TrackerUpdate"]);
    expect(await claimComments(make(), "ENG-4")).toEqual({
      markers: 1,
      outcomes: ["claimed", "released"],
    });
  });

  it("on Jira", async () => {
    const s = jiraClaimStore("Todo");
    let mover: Record<string, unknown> = MEMBER;
    let blocker: { status: string; category: "indeterminate" | "done" } = {
      status: "Doing",
      category: "indeterminate",
    };
    const answer = (c: Call) => {
      if (c.route === "GET issueLinkType")
        return {
          issueLinkTypes: [
            {
              id: "1",
              name: "Blocks",
              inward: "is blocked by",
              outward: "blocks",
            },
            {
              id: "2",
              name: "Relates",
              inward: "relates to",
              outward: "relates to",
            },
            {
              id: "3",
              name: "Duplicate",
              inward: "is duplicated by",
              outward: "duplicates",
            },
          ],
        };
      if (c.route === "GET issue/ENG-2")
        return jiraIssue({ key: "ENG-2", ...blocker });
      if (c.route === "GET myself") return { ...FACTORY, timeZone: "UTC" };
      if (c.route === "GET user") return FACTORY;
      if (c.route === "GET issue/ENG-1")
        return c.query.fields === "creator"
          ? { key: "ENG-1", fields: { creator: MEMBER } }
          : jiraIssue({
              key: "ENG-1",
              ...s.item,
              links: [{ type: "Blocks", inward: "ENG-2" }],
            });
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
          s.item.assignee === null &&
          jql.includes(`"${s.item.status}"`);
        return listed ? page(jiraIssue({ key: "ENG-1", ...s.item })) : page();
      }
      return s.answer(c);
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
    await waitsOn(make, section, "ENG-1", "ENG-2");
    blocker = { status: "Done", category: "done" };
    expect(await twoHosts(make, section, "ENG-1")).toEqual([
      "claimed",
      "refused",
    ]);
    expect(s.writes).toEqual([
      "PUT issue/ENG-1/assignee",
      "POST issue/ENG-1/transitions",
    ]);
    expect(await claimComments(make(), "ENG-1")).toEqual({
      markers: 1,
      outcomes: ["claimed", "released"],
    });
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
      isEpic: false,
      hasOpenChildren: false,
      truncated: [],
    };
    let current = issue;
    const reads: string[] = [];
    const tracker = {
      adapter: "linear",
      team: "ENG",
      stateName: (s: string) => (s === "todo" ? "Todo" : null),
      user: async () => ({ id: "u-f", name: "Factory" }),
      viewer: async () => ({ id: "u-f", name: "Factory" }),
      unassignedIssues: async () => [current],
      listRelations: async () => [],
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

describe("the pool's guards", () => {
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
    isEpic: false,
    hasOpenChildren: false,
    truncated: [],
  };
  const trackerOf = (over: Record<string, unknown> = {}) =>
    ({
      adapter: "linear",
      team: "ENG",
      stateName: (s: string) => (s === "todo" ? "Todo" : null),
      user: async () => ({ id: "u-f", name: "Factory" }),
      viewer: async () => ({ id: "u-f", name: "Factory" }),
      unassignedIssues: async () => [issue],
      poolIssue: async () => issue,
      listRelations: async () => [],
      stateChangedBy: async () => ({ id: "u-d", name: "Dana", trusted: true }),
      ...over,
    }) as unknown as Tracker;
  const section = poolSection("factory@example.invalid");

  it("reads nothing under an invalid repository scope", async () => {
    const read = await readPoolPickups(trackerOf(), section, {
      repoScope: { invalid: "two labels" } as never,
    });
    expect(read.wanted).toEqual([]);
    expect(read.failed).toBe(true);
    expect(read.unplaced[0]?.reason).toContain("repository scope is invalid");
  });

  it("reads nothing when the credential is not the dispatch identity", async () => {
    const read = await readPoolPickups(
      trackerOf({ viewer: async () => ({ id: "u-x", name: "Someone" }) }),
      section,
    );
    expect(read.wanted).toEqual([]);
    expect(read.unplaced[0]?.reason).toContain("not as the dispatch identity");
  });

  it("launches a pooled pickup only as a pool item, though it was assigned since", async () => {
    const assigned = { ...issue, assignee: { id: "u-f", name: "Factory" } };
    const tracker = trackerOf({
      poolIssue: async () => assigned,
      assignedIssues: async () => [assigned],
      assignedBy: async () => ({ id: "u-d", name: "Dana", trusted: true }),
    });
    expect(typeof (await freshPickup(tracker, section, "ENG-9"))).toBe(
      "object",
    );
    expect(
      await freshPickup(tracker, section, "ENG-9", undefined, true),
    ).toContain("is assigned to");
  });

  it("reads the pool's state by the item's own native type", async () => {
    const bug = {
      ...issue,
      nativeType: "Bug",
      state: { id: "s-ready", name: "Ready", type: "unstarted" },
    };
    const tracker = trackerOf({
      stateName: (s: string, type?: string | null) =>
        s === "todo" ? (type === "Bug" ? "Ready" : "Todo") : null,
      poolIssue: async () => bug,
      unassignedIssues: async () => [bug],
    });
    expect(typeof (await freshPoolPickup(tracker, section, "ENG-9"))).toBe(
      "object",
    );
  });

  it("refuses a launch of an item that left the pool's scope", async () => {
    const tracker = trackerOf({ unassignedIssues: async () => [] });
    expect(await freshPoolPickup(tracker, section, "ENG-9")).toContain(
      "no longer in the ready pool's scope",
    );
  });

  it("stops reading who made items ready once the tick's bound ends", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = await readPoolPickups(trackerOf(), section, {}, undefined, {
      signal: controller.signal,
      deadline: Date.now() + 1000,
    } as never);
    expect(read.wanted).toEqual([]);
    expect(read.failed).toBe(true);
  });
});
