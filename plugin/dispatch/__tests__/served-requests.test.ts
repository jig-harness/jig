/**
 * How many requests a served queue costs the tracker: a queue of 50
 * assignments, each with a blocker and a parent, read through the Linear
 * adapter over a fake workspace that counts every request.
 */
import { describe, expect, it } from "bun:test";
import type { PickupReads } from "../lib/pickup-reads.ts";
import {
  readServedPickups,
  type ServedOptions,
} from "../lib/sources/served.ts";
import type { ServedViews } from "../lib/sources/served-reads.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import type { DispatchSection } from "../lib/types.ts";
import { TrackerRateLimited } from "../../shared/tracker-budget.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { linearTracker } from "../../skills/do-item/scripts/lib/tracker/linear.ts";
import { parseTrackerConfig } from "../../skills/do-item/scripts/lib/tracker/config.ts";
import { renderExecutionPlan } from "../../skills/do-item/scripts/lib/execution-plan.ts";
import { FakeLinear } from "./served-linear-fake.ts";

const PERSON = "person@example.com";
const people = [
  { name: "Person", forge: ["person"], tracker: { linear: PERSON } },
];
const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function memoryCache(): PickupReads {
  const store = new Map<string, string>();
  return {
    get: <T>(k: string) => {
      const v = store.get(k);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    set: (k, v) => {
      store.set(k, JSON.stringify(v));
    },
  };
}

/** A parent's plan: a finished sibling step, then the assigned child. */
function plan(parent: string, sibling: string, child: string): string {
  return `## Execution Plan\n${renderExecutionPlan({
    epic: parent,
    intent: "deliver",
    steps: [
      { issue: sibling, band: 1, lane: "a", gate: "agent" },
      { issue: child, band: 2, lane: "a", gate: "agent" },
    ],
    edges: [
      {
        from: sibling,
        to: child,
        kind: "dependency",
        reason: "builds on it",
        completion: "done",
      },
    ],
    gates: [],
  })}`;
}

/**
 * Fifty assignments, each blocked by a finished issue and under a parent of
 * its own whose execution plan puts a finished sibling first.
 */
function queue(): FakeLinear {
  const fake = new FakeLinear();
  for (let n = 1; n <= 50; n++) {
    fake.add({
      identifier: `ENG-${300 + n}`,
      description: plan(`ENG-${300 + n}`, `ENG-${400 + n}`, `ENG-${n}`),
      state: { name: "In Progress", type: "started" },
    });
    fake.add({
      identifier: `ENG-${400 + n}`,
      parent: `ENG-${300 + n}`,
      state: { name: "Done", type: "completed" },
    });
    fake.add({
      identifier: `ENG-${100 + n}`,
      state: { name: "Done", type: "completed" },
    });
    fake.add({
      identifier: `ENG-${n}`,
      assignee: PERSON,
      parent: `ENG-${300 + n}`,
      blockedBy: [`ENG-${100 + n}`],
    });
  }
  return fake;
}

function tick(
  tracker: Tracker,
  cache: PickupReads,
  minutes: number,
  views: ServedViews = new Map(),
) {
  const options: ServedOptions = {
    cache,
    nowMs: T0 + minutes * 60_000,
    headroom: true,
    views,
  };
  return readServedPickups(tracker, people, options);
}

describe("a served queue's cost in tracker requests", () => {
  it("costs at most 3 requests when nothing changed and at most 5 when one issue did", async () => {
    const fake = queue();
    const tracker = fake.tracker();
    const cache = memoryCache();
    const first = await tick(tracker, cache, 0);
    expect(first.wanted).toHaveLength(50);
    expect(first.unplaced).toEqual([]);
    const cold = fake.count();
    // The queue in two pages, each assignment's history once, and every plan step in one lookup of two pages.
    expect(
      fake.requests.filter((r) => r !== "TrackerAssignmentHistory"),
    ).toEqual([
      "TrackerQueue",
      "TrackerQueue",
      "TrackerQueueByKey",
      "TrackerQueueByKey",
    ]);

    const before = fake.count();
    const unchanged = await tick(tracker, cache, 2);
    const quiet = fake.count() - before;
    expect(quiet).toBeLessThanOrEqual(3);
    expect(fake.requests.slice(before)).toEqual(["TrackerChanges"]);
    expect(unchanged.wanted.map((w) => w.key)).toEqual(
      first.wanted.map((w) => w.key),
    );

    // A blocker reopens: its item is held behind it.
    fake.touch("ENG-107", at(3), {
      state: { name: "In Progress", type: "started" },
    });
    let mark = fake.count();
    const blocked = await tick(tracker, cache, 4);
    const blockerChange = fake.count() - mark;
    expect(blockerChange).toBeLessThanOrEqual(5);
    expect(blocked.wanted.map((w) => w.key)).not.toContain("ENG-7");
    expect(blocked.unplaced).toContainEqual(
      expect.objectContaining({
        target: "ENG-7",
        reason: expect.stringContaining("waiting on ENG-107"),
      }),
    );

    // An assignment itself changes.
    fake.touch("ENG-9", at(5), {
      state: { name: "In Progress", type: "started" },
    });
    mark = fake.count();
    const started = await tick(tracker, cache, 6);
    const itemChange = fake.count() - mark;
    expect(itemChange).toBeLessThanOrEqual(5);
    expect(started.wanted.map((w) => w.key)).not.toContain("ENG-9");

    // A parent's description changes to a plan of another epic: its child is held.
    fake.touch("ENG-311", at(7), {
      description: plan("ENG-999", "ENG-411", "ENG-11"),
    });
    mark = fake.count();
    const replanned = await tick(tracker, cache, 8);
    const parentChange = fake.count() - mark;
    expect(parentChange).toBeLessThanOrEqual(5);
    expect(replanned.wanted.map((w) => w.key)).not.toContain("ENG-11");
    expect(replanned.unplaced).toContainEqual(
      expect.objectContaining({
        target: "ENG-11",
        reason: expect.stringContaining("different epic"),
      }),
    );

    // And quiet again.
    mark = fake.count();
    await tick(tracker, cache, 10);
    expect(fake.count() - mark).toBeLessThanOrEqual(3);

    console.log(
      JSON.stringify({ cold, quiet, blockerChange, itemChange, parentChange }),
    );
  });

  it("keeps a history that names no user assignment until the item changes", async () => {
    for (const history of ["none", "no-user"] as const) {
      const fake = queue();
      fake.add({ identifier: "ENG-900", assignee: PERSON, history });
      const tracker = fake.tracker();
      const cache = memoryCache();
      const first = await tick(tracker, cache, 0);
      const row = first.unplaced.find((u) => u.target === "ENG-900");
      expect(row?.reason).toContain(
        history === "none"
          ? "its history holds no assignment of"
          : "its assignment was made by no user",
      );
      const mark = fake.count();
      const second = await tick(tracker, cache, 2);
      expect(fake.requests.slice(mark)).toEqual(["TrackerChanges"]);
      expect(second.unplaced.find((u) => u.target === "ENG-900")).toEqual(row);
      expect(second.wanted).toHaveLength(50);

      // The item changes: its history is read again.
      fake.touch("ENG-900", at(3));
      const changed = fake.count();
      await tick(tracker, cache, 4);
      expect(fake.requests.slice(changed)).toContain(
        "TrackerAssignmentHistory",
      );
    }
  });

  it("reads neither the children nor the description of an epic no user assigned", async () => {
    const fake = queue();
    fake.add({
      identifier: "ENG-900",
      assignee: PERSON,
      labels: ["epic"],
      history: "none",
    });
    fake.add({ identifier: "ENG-901", parent: "ENG-900" });
    const read = await tick(fake.tracker(), memoryCache(), 0);
    expect(read.unplaced).toContainEqual(
      expect.objectContaining({
        target: "ENG-900",
        reason: expect.stringContaining("its history holds no assignment of"),
      }),
    );
    expect(fake.requests).not.toContain("TrackerOpenChildren");
    expect(fake.requests).not.toContain("TrackerIssue");
  });

  it("reads a malformed history again on the next tick", async () => {
    for (const history of ["no-actor", "bad-target"] as const) {
      const fake = queue();
      fake.add({ identifier: "ENG-900", assignee: PERSON, history });
      const tracker = fake.tracker();
      const cache = memoryCache();
      await tick(tracker, cache, 0);
      const mark = fake.count();
      await tick(tracker, cache, 2);
      expect(fake.requests.slice(mark)).toContain("TrackerAssignmentHistory");
    }
  });

  it("reads a failed history again on the next tick", async () => {
    const fake = queue();
    fake.add({ identifier: "ENG-900", assignee: PERSON, history: "fail" });
    const tracker = fake.tracker();
    const cache = memoryCache();
    const first = await tick(tracker, cache, 0);
    expect(first.unplaced).toContainEqual(
      expect.objectContaining({
        target: "ENG-900",
        reason: expect.stringContaining("cannot be read"),
      }),
    );
    const mark = fake.count();
    await tick(tracker, cache, 2);
    expect(fake.requests.slice(mark)).toContain("TrackerAssignmentHistory");
  });

  it("reads a rate-limited history again on the next tick", async () => {
    const fake = queue();
    fake.add({ identifier: "ENG-900", assignee: PERSON });
    const base = fake.tracker();
    let refuse = true;
    const tracker: Tracker = {
      ...base,
      assignedBy: async (key, assignee) => {
        if (refuse && key === "ENG-900")
          throw new TrackerRateLimited("linear", T0 + 60_000, "RATELIMITED");
        return base.assignedBy(key, assignee);
      },
    };
    const cache = memoryCache();
    const first = await tick(tracker, cache, 0);
    expect(first.limitedUntil).toBeDefined();
    refuse = false;
    const second = await tick(tracker, cache, 2);
    expect(second.limitedUntil).toBeUndefined();
    expect(second.wanted.map((w) => w.key)).toContain("ENG-900");
  });

  it("ignores a change to another team's issue assigned to the same person", async () => {
    const fake = queue();
    const tracker = fake.tracker();
    const cache = memoryCache();
    await tick(tracker, cache, 0);
    fake.add({ identifier: "OTHER-1", assignee: PERSON, updatedAt: at(1) });
    const mark = fake.count();
    await tick(tracker, cache, 2);
    expect(fake.requests.slice(mark)).toEqual(["TrackerChanges"]);
  });

  it("reports an incomplete answer when more issues changed than one probe page holds", async () => {
    const fake = queue();
    const tracker = fake.tracker();
    const keys = [...fake.issues.keys()];
    const ask = () =>
      (tracker.changedSince as NonNullable<Tracker["changedSince"]>)({
        since: at(0),
        identity: PERSON,
        keys,
      });
    for (let n = 1; n <= 50; n++) fake.touch(`ENG-${300 + n}`, at(1));
    expect((await ask()).complete).toBe(true);
    fake.touch("ENG-401", at(1));
    expect((await ask()).complete).toBe(false);
  });

  it("reads the queue whole again every quarter hour, even when the probe sees nothing", async () => {
    const fake = queue();
    const tracker = fake.tracker();
    const cache = memoryCache();
    await tick(tracker, cache, 0);
    await tick(tracker, cache, 2);
    const mark = fake.count();
    await tick(tracker, cache, 16);
    expect(fake.requests.slice(mark)).toContain("TrackerQueue");
    expect(fake.requests.slice(mark)).not.toContain("TrackerChanges");
  });

  it("reads one queue for two repositories naming the same team and person", async () => {
    const fake = queue();
    const cache = memoryCache();
    const run = async (minutes: number) => {
      const views: ServedViews = new Map();
      const section = { identity: null } as DispatchSection;
      const read = (repo: string) =>
        readPickups(() => fake.tracker(), section, undefined, {
          cache,
          people,
          nowMs: T0 + minutes * 60_000,
          headroom: true,
          views,
          repoScope: { own: repo, others: [] },
        } as Parameters<typeof readPickups>[3]);
      const mark = fake.count();
      const [a, b] = await Promise.all([read("repo:a"), read("repo:b")]);
      return { a, b, requests: fake.count() - mark };
    };
    const shared = await run(0);
    const alone = queue();
    await tick(alone.tracker(), memoryCache(), 0);
    expect(shared.requests).toBe(alone.count());
    expect(shared.a.wanted).toHaveLength(50);
    expect(shared.b.wanted).toHaveLength(50);
    expect((await run(2)).requests).toBeLessThanOrEqual(3);
  });

  it("reads a queue per configuration when repositories map the tracker differently", async () => {
    const fake = queue();
    const cache = memoryCache();
    const views: ServedViews = new Map();
    const a = { ...fake.tracker(), configKey: "a" };
    const b = { ...fake.tracker(), configKey: "b" };
    const mark = fake.count();
    await Promise.all([tick(a, cache, 0, views), tick(b, cache, 0, views)]);
    const both = fake.count() - mark;
    const alone = queue();
    await tick(alone.tracker(), memoryCache(), 0);
    expect(both).toBeGreaterThan(alone.count());
    expect(views.size).toBe(2);
  });

  it("asks for every working state, a separately named pr_open included", async () => {
    const fake = queue();
    const base = fake.tracker();
    const asked: string[][] = [];
    const tracker: Tracker = {
      ...base,
      stateName: ((s: string) =>
        s === "pr_open" ? "PR Open" : base.stateName(s as never)) as never,
      queueIssues: async (identity, states, signal) => {
        asked.push([...states]);
        return (base.queueIssues as NonNullable<Tracker["queueIssues"]>)(
          identity,
          states,
          signal,
        );
      },
    };
    await tick(tracker, memoryCache(), 0);
    expect(asked[0]).toContain("pr_open");
    expect(asked[0]).toContain("in_progress");
  });

  it("writes one rate-limited row for a repository with a factory identity and served people, and fails no record", async () => {
    const fake = queue();
    const reset = T0 + 30 * 60_000;
    const refuse = async () => {
      throw new TrackerRateLimited("linear", reset, "RATELIMITED");
    };
    const limited: Tracker = {
      ...fake.tracker(),
      assignedIssues: refuse,
      assignedBy: refuse,
      queueIssues: refuse,
      changedSince: refuse,
    };
    const read = await readPickups(
      () => limited,
      {
        identity: "factory@example.com",
        states: ["todo"],
      } as unknown as DispatchSection,
      undefined,
      { cache: memoryCache(), people, nowMs: T0, headroom: true },
    );
    expect(read.read.ok).toBe(true);
    expect(read.unplaced).toEqual([
      expect.objectContaining({
        target: "linear ENG",
        reason: expect.stringContaining(
          `rate limited until ${new Date(reset).toISOString()}`,
        ),
      }),
    ]);
    expect(read.wanted).toEqual([]);
    expect(fake.count()).toBe(0);
  });

  it("leaves the claims unknown when the limit stopped the served queue, so no ended pickup is released", async () => {
    const fake = queue();
    const reset = T0 + 30 * 60_000;
    const limited: Tracker = {
      ...fake.tracker(),
      queueIssues: async () => {
        throw new TrackerRateLimited("linear", reset, "RATELIMITED");
      },
    };
    const read = await readPickups(
      () => limited,
      { identity: null } as DispatchSection,
      undefined,
      { cache: memoryCache(), people, nowMs: T0, headroom: true },
    );
    expect(read.read.ok).toBe(true);
    expect(read.claimed).toBeNull();
    expect(read.unplaced).toHaveLength(1);
  });

  it("reports a rate-limited tracker once, keeps the last reading, and sends nothing", async () => {
    const fake = queue();
    const cache = memoryCache();
    const tracker = fake.tracker();
    await tick(tracker, cache, 0);
    const reset = T0 + 30 * 60_000;
    const limited: Tracker = {
      ...tracker,
      changedSince: async () => {
        throw new TrackerRateLimited("linear", reset, "RATELIMITED");
      },
      poolIssue: async () => {
        throw new TrackerRateLimited("linear", reset, "RATELIMITED");
      },
      poolIssues: async () => {
        throw new TrackerRateLimited("linear", reset, "RATELIMITED");
      },
    };
    const mark = fake.count();
    const read = await tick(limited, cache, 2);
    expect(fake.count()).toBe(mark);
    expect(read.unplaced).toHaveLength(1);
    expect(read.unplaced[0]?.reason).toContain(
      `rate limited until ${new Date(reset).toISOString()}`,
    );
    expect(read.limitedUntil).toBe(new Date(reset).toISOString());
    expect(read.wanted).toHaveLength(50);
  });
});

/** A tracker over `fake` whose key filters are the bare `{ team, number }` groups Linear answers with the whole team. */
function bareGroupTracker(fake: FakeLinear): Tracker {
  return linearTracker({
    team: "ENG",
    states: parseTrackerConfig({}).states,
    transport: (query, variables, signal) =>
      fake.transport(
        query,
        {
          ...variables,
          filter: {
            or: [{ team: { key: { eq: "ENG" } }, number: { in: [1] } }],
          },
        },
        signal,
      ),
  });
}

/** A team of 300 issues, ten of which a read names, the rest recently updated bystanders. */
function crowdedTeam(): FakeLinear {
  const fake = new FakeLinear();
  for (let n = 1; n <= 300; n++)
    fake.add({ identifier: `ENG-${n}`, updatedAt: at(5) });
  return fake;
}

describe("reads by key in a team with many other issues", () => {
  it("reads the named keys in one request, not the team's pages", async () => {
    const fake = crowdedTeam();
    const keys = Array.from({ length: 10 }, (_, i) => `ENG-${i * 20 + 1}`);
    const read = await fake.tracker().poolIssues?.(keys);
    expect([...(read?.keys() ?? [])].sort()).toEqual([...keys].sort());
    expect(fake.requests).toEqual(["TrackerPoolIssues"]);
  });

  it("reads 120 keys in three requests", async () => {
    const fake = crowdedTeam();
    const keys = Array.from({ length: 120 }, (_, i) => `ENG-${i + 1}`);
    await fake.tracker().poolIssues?.(keys);
    expect(fake.requests).toEqual(Array(3).fill("TrackerPoolIssues"));
  });

  it("stops when the filter matches more than the keys named", async () => {
    const fake = crowdedTeam();
    // Linear matches the whole team when a bare `{ team, number }` sits in an `or`.
    const tracker = bareGroupTracker(fake);
    await expect(tracker.poolIssues?.(["ENG-1", "ENG-2"])).rejects.toThrow(
      /paging past its keys/,
    );
    expect(fake.requests.length).toBeLessThanOrEqual(3);
  });

  it("does not take a bystander's update for a change to what the reading depends on", async () => {
    const fake = crowdedTeam();
    fake.add({ identifier: "ENG-900", assignee: PERSON, updatedAt: at(0) });
    const since = at(1);
    const answer = await fake.tracker().changedSince?.({
      since,
      identity: PERSON,
      keys: ["ENG-1", "ENG-2"],
    });
    expect(answer?.keys).toEqual(["ENG-1", "ENG-2"]);
    expect(answer?.complete).toBe(true);
    const none = await fake.tracker().changedSince?.({
      since,
      identity: PERSON,
      keys: ["ENG-900"],
    });
    expect(none?.keys).toEqual([]);
  });
});

/** An epic assigned to the person with `n` children, each blocked by a finished issue. */
function epic(n: number): FakeLinear {
  const fake = new FakeLinear();
  fake.add({
    identifier: "ENG-1000",
    state: { name: "Done", type: "completed" },
  });
  fake.add({
    identifier: "ENG-1",
    assignee: PERSON,
    labels: ["epic"],
    description: "An epic with no plan.",
  });
  for (let c = 1; c <= n; c++)
    fake.add({
      identifier: `ENG-${100 + c}`,
      parent: "ENG-1",
      blockedBy: ["ENG-1000"],
    });
  return fake;
}

describe("an epic's children read together with their relations", () => {
  it("reads the relations of every child in the batch, not one issue at a time", async () => {
    const fake = epic(60);
    const cache = memoryCache();
    const read = await tick(fake.tracker(), cache, 0);
    const ops = fake.requests.filter((r) => r !== "TrackerAssignmentHistory");
    expect(ops.filter((r) => r === "TrackerRelations")).toHaveLength(0);
    expect(ops.filter((r) => r === "TrackerInverseRelations")).toHaveLength(0);
    // 60 children in three pages, then the blocker they share.
    expect(ops.filter((r) => r === "TrackerQueueByKey")).toHaveLength(4);
    expect(read.wanted.map((w) => w.key)).toEqual(["ENG-101"]);
    // The next tick, with nothing changed, reads no child again.
    const before = fake.count();
    await tick(fake.tracker(), cache, 2);
    expect(fake.requests.slice(before)).toEqual(["TrackerChanges"]);
  });

  it("reads an issue with more relations than a page holds on its own, and only that one", async () => {
    const fake = epic(2);
    for (let b = 1; b <= 21; b++)
      fake.add({
        identifier: `ENG-${2000 + b}`,
        state: { name: "Done", type: "completed" },
      });
    fake.add({
      identifier: "ENG-102",
      parent: "ENG-1",
      blockedBy: Array.from({ length: 21 }, (_, b) => `ENG-${2001 + b}`),
    });
    await tick(fake.tracker(), memoryCache(), 0);
    // One request per direction, for the one issue whose relations overflowed.
    expect(fake.requests.filter((r) => r === "TrackerRelations")).toHaveLength(
      1,
    );
    expect(
      fake.requests.filter((r) => r === "TrackerInverseRelations"),
    ).toHaveLength(1);
  });

  it("pages an epic's open children as the tracker does", async () => {
    const fake = epic(101);
    await tick(fake.tracker(), memoryCache(), 0);
    expect(
      fake.requests.filter((r) => r === "TrackerOpenChildren"),
    ).toHaveLength(2);
  });

  it("costs a cold tick a number of requests that grows with pages, not children", async () => {
    const small = epic(10);
    await tick(small.tracker(), memoryCache(), 0);
    const large = epic(100);
    await tick(large.tracker(), memoryCache(), 0);
    // 100 children are four pages of the by-key read; the rest of the cold tick is the same.
    expect(large.count() - small.count()).toBeLessThanOrEqual(4);
  });
});

describe("queueIssuesByKey", () => {
  it("carries each issue's relations and parent, and omits a key the list does not hold", async () => {
    const fake = epic(3);
    const read = await fake
      .tracker()
      .queueIssuesByKey?.(["ENG-101", "ENG-999"]);
    expect([...(read?.keys() ?? [])]).toEqual(["ENG-101"]);
    const child = read?.get("ENG-101");
    expect(child?.relations).toEqual([
      { type: "blocked_by", issue: "ENG-1000", state: "completed" },
    ]);
    expect(child?.parent?.issue.identifier).toBe("ENG-1");
    expect(fake.requests).toEqual(["TrackerQueueByKey"]);
  });

  it("stops when the filter matches more than the keys named", async () => {
    const fake = crowdedTeam();
    const tracker = bareGroupTracker(fake);
    await expect(tracker.queueIssuesByKey?.(["ENG-1"])).rejects.toThrow(
      /paging past its keys/,
    );
    expect(fake.requests.length).toBeLessThanOrEqual(3);
  });
});

describe("a nested epic's parents on the tick after a cold one", () => {
  /** An epic assigned to the person, a sub-epic nobody holds, and `n` leaves under the sub-epic. */
  function nested(n: number): FakeLinear {
    const fake = new FakeLinear();
    fake.add({
      identifier: "ENG-1",
      assignee: PERSON,
      labels: ["epic"],
      description: "The epic.",
    });
    fake.add({
      identifier: "ENG-2",
      parent: "ENG-1",
      labels: ["epic"],
      description: "The sub-epic.",
    });
    for (let c = 1; c <= n; c++)
      fake.add({ identifier: `ENG-${10 + c}`, parent: "ENG-2" });
    return fake;
  }

  it("reads no parent again when nothing changed", async () => {
    const fake = nested(30);
    const tracker = fake.tracker();
    const cache = memoryCache();
    const first = await tick(tracker, cache, 0);
    expect(first.wanted).toHaveLength(1);
    const before = fake.count();
    const second = await tick(tracker, cache, 2);
    expect(fake.requests.slice(before)).toEqual(["TrackerChanges"]);
    expect(second.wanted.map((pickup) => pickup.key)).toEqual(
      first.wanted.map((pickup) => pickup.key),
    );
    expect(second.unplaced).toEqual(first.unplaced);
  });
});

describe("what a history read costs Linear", () => {
  it("bounds the actor's team connection, which Linear prices per history node", async () => {
    const fake = new FakeLinear();
    fake.add({ identifier: "ENG-1", assignee: PERSON });
    const queries: string[] = [];
    const tracker = linearTracker({
      team: "ENG",
      states: parseTrackerConfig({}).states,
      transport: (query, variables, signal) => {
        queries.push(query);
        return fake.transport(query, variables, signal);
      },
    });
    const by = await tracker.assignedBy("ENG-1", PERSON);
    expect(by.trusted).toBe(true);
    expect(queries).toHaveLength(1);
    // An unbounded connection is priced at Linear's default page of 50 for each of
    // up to 100 history nodes: 6,013 points for 57 nodes, against 623 bounded.
    expect(queries[0]).toContain("teams(first: 1, filter:");
    expect(queries[0]).not.toMatch(/teams\((?!first:)/);
  });
});
