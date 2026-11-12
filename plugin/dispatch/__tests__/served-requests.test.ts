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
    epic: "epic",
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
    // The queue in two pages, each assignment's history once, and every plan step in one lookup.
    expect(
      fake.requests.filter((r) => r !== "TrackerAssignmentHistory"),
    ).toEqual(["TrackerQueue", "TrackerQueue", "TrackerPoolIssues"]);

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
    const tracker = linearTracker({
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
