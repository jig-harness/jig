import { sharedDispatchRead } from "../../skills/do-item/scripts/lib/tracker/dispatch-shared.ts";
import { expect, it } from "bun:test";
import type {
  Tracker,
  PoolIssue,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { sharedView, type ServedViews } from "../lib/sources/served-reads.ts";
import { readServedPickups } from "../lib/sources/served.ts";
import { issue } from "./served-fixtures.ts";

it("shares native queues across state and facet mappings, retaining each repository projection", async () => {
  const saved = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (saved.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      saved.set(key, value);
    },
  };
  let queues = 0;
  let probes = 0;
  const rows = [issue("TEAM-1"), issue("TEAM-2")];
  const tracker = (size: string, todo: string) =>
    ({
      adapter: "linear",
      team: "TEAM",
      configKey: size,
      stateName: (s: string) =>
        s === "todo" ? todo : s === "in_progress" ? "Doing" : null,
      assignedIssues: async () => {
        queues++;
        return rows;
      },
      changedSince: async () => {
        probes++;
        return { keys: [], complete: true, latest: null };
      },
      dispatchSource: {
        credential: async () => "hashed-credential",
        queue: async () => {
          queues++;
          return rows.map((value) => ({ identifier: value.identifier, value }));
        },
        issue: async () => null,
        children: async () => [],
        project: async (raw: { value: unknown }) => ({
          ...(raw.value as PoolIssue),
          size,
        }),
      },
    }) as unknown as Tracker;
  const first = tracker("small", "Todo");
  const second = tracker("large", "Other");
  const options = { nowMs: 100000, headroom: true };
  const views: ServedViews = new Map();
  const a = await sharedView(views, first, "alex", options, cache);
  const b = await sharedView(views, second, "alex", options, cache);
  expect(a.open().map((h) => h.issue.size)).toEqual(["small", "small"]);
  expect(b.open()).toEqual([]);
  a.save();
  b.save();
  expect(queues).toBe(1);
  expect([...saved.keys()].filter((k) => k.includes(":queue:")).length).toBe(1);
  const next: ServedViews = new Map();
  await sharedView(next, first, "alex", { ...options, nowMs: 160000 }, cache);
  await sharedView(next, second, "alex", { ...options, nowMs: 160000 }, cache);
  expect(probes).toBe(1);
  expect(queues).toBe(1);
});

it("keeps native snapshots isolated by credential and instance, and reuses kept rows without offline calls", async () => {
  const saved = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (saved.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      saved.set(key, value);
    },
  };
  let queues = 0;
  let probes = 0;
  let online = true;
  let facts = 0;
  const make = (credential: string, instance = "one") =>
    ({
      adapter: "linear",
      team: "TEAM",
      instance,
      stateName: (state: string) => (state === "todo" ? "Todo" : null),
      changedSince: async () => {
        probes++;
        if (!online) throw new Error("unreachable");
        return { keys: [], complete: true, latest: null };
      },
      dispatchSource: {
        credential: async () => credential,
        queue: async () => {
          queues++;
          return [{ identifier: "TEAM-1", value: issue("TEAM-1") }];
        },
        issue: async () => {
          facts++;
          return null;
        },
        children: async () => [],
        project: async (raw: { value: unknown }) => raw.value as PoolIssue,
      },
    }) as unknown as Tracker;
  const a = make("credential-a");
  const b = make("credential-b");
  const c = make("credential-a", "two");
  const options = { nowMs: 100000, headroom: true };
  const initial: ServedViews = new Map();
  for (const tracker of [a, b, c])
    (await sharedView(initial, tracker, "alex", options, cache)).save();
  expect(queues).toBe(3);
  expect([...saved.keys()].filter((k) => k.includes(":queue:")).length).toBe(3);
  online = false;
  const next: ServedViews = new Map();
  const [first, second] = await Promise.all(
    [a, a].map((t) =>
      sharedView(next, t, "alex", { ...options, nowMs: 160000 }, cache),
    ),
  );
  expect(probes).toBe(1);
  if (first === undefined || second === undefined)
    throw new Error("both shared projections are required");
  expect(first.unavailable).toBe("unreachable");
  expect(second.open().map((h) => h.issue.identifier)).toEqual(["TEAM-1"]);
  expect(second.readAt).toBe(100000);
  await expect(
    second.once("missing fact", async () => {
      facts++;
      return true;
    }),
  ).rejects.toThrow("unreachable");
  await expect(second.pool("TEAM-2")).rejects.toThrow("unreachable");
  expect(facts).toBe(0);
});

it("starts no native read or projection after the tick's deadline", async () => {
  let calls = 0;
  const tracker = {
    adapter: "linear",
    team: "TEAM",
    dispatchSource: {
      credential: async () => {
        calls++;
        return "credential";
      },
    },
  } as unknown as Tracker;
  const controller = new AbortController();
  controller.abort();
  await expect(
    sharedView(
      new Map(),
      tracker,
      "alex",
      {
        nowMs: 0,
        headroom: true,
        bound: { deadline: 0, signal: controller.signal },
      },
      { get: () => null, set: () => undefined },
    ),
  ).rejects.toThrow("deadline");
  expect(calls).toBe(0);
});

it("probes one scope once for every served person and all saved dependencies", async () => {
  const saved = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (saved.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      saved.set(key, value);
    },
  };
  const probes: import("../../skills/do-item/scripts/lib/tracker/port.ts").ChangeQuery[] =
    [];
  const tracker = {
    adapter: "linear",
    team: "TEAM",
    stateName: (state: string) => (state === "todo" ? "Todo" : null),
    changedSince: async (
      query: import("../../skills/do-item/scripts/lib/tracker/port.ts").ChangeQuery,
    ) => {
      probes.push(query);
      return { keys: [], complete: true, latest: null };
    },
    dispatchSource: {
      credential: async () => "credential",
      queue: async (identity: string) => [
        { identifier: identity, value: issue(identity) },
      ],
      issue: async () => null,
      children: async () => [],
      project: async (raw: { value: unknown }) => raw.value as PoolIssue,
    },
  } as unknown as Tracker;
  const options = {
    nowMs: 100000,
    headroom: true,
    scopeIdentities: ["alex", "sam"],
  };
  const initial: ServedViews = new Map();
  for (const identity of options.scopeIdentities)
    (await sharedView(initial, tracker, identity, options, cache)).save();
  const next: ServedViews = new Map();
  await Promise.all(
    options.scopeIdentities.map((identity) =>
      sharedView(next, tracker, identity, { ...options, nowMs: 160000 }, cache),
    ),
  );
  expect(probes).toHaveLength(1);
  expect(probes[0]?.identities).toEqual(["alex", "sam"]);
  expect([...(probes[0]?.keys ?? [])].sort()).toEqual(["alex", "sam"]);
});

it("reinterprets cached queue relations when a repository changes its Jira link mapping", async () => {
  const saved = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (saved.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      saved.set(key, value);
    },
  };
  const root = issue("TEAM-1");
  const blocker = issue("TEAM-2", [], "elsewhere");
  const raw = (row: PoolIssue) => ({
    identifier: row.identifier,
    value: row,
    parent: null,
  });
  let queueReads = 0;
  let projections = 0;
  const tracker = (relation: "blocks" | "blocked_by") =>
    ({
      adapter: "jira",
      team: "TEAM",
      readinessKey: relation,
      stateName: (state: string) => (state === "todo" ? "Todo" : null),
      changedSince: async () => ({ keys: [], complete: true, latest: null }),
      assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
      dispatchSource: {
        credential: async () => "credential",
        queue: async () => {
          queueReads++;
          return [raw(root)];
        },
        issue: async (key: string) =>
          key === "TEAM-2" ? raw(blocker) : raw(root),
        children: async () => [],
        project: async (row: { value: unknown }) => row.value as PoolIssue,
        projectRelations: async (row: { identifier: string }) => {
          projections++;
          return row.identifier === "TEAM-1"
            ? [{ type: relation, issue: "TEAM-2" }]
            : [];
        },
      },
    }) as unknown as Tracker;
  const people = [{ name: "Alex", forge: ["alex"], tracker: { jira: "alex" } }];
  const first = await readServedPickups(tracker("blocks"), people, {
    cache,
    nowMs: 100000,
    headroom: true,
    views: new Map(),
  });
  expect(first.wanted.map((row) => row.key)).toEqual(["TEAM-1"]);
  const warm = await readServedPickups(tracker("blocked_by"), people, {
    cache,
    nowMs: 160000,
    headroom: true,
    views: new Map(),
  });
  expect(queueReads).toBe(1);
  expect(warm.wanted).toEqual([]);
  expect(warm.unplaced).toContainEqual(
    expect.objectContaining({
      target: "TEAM-1",
      reason: expect.stringContaining("TEAM-2"),
    }),
  );
  expect(projections).toBe(2);
});

it("reads the shared parent and its facts once for two served people", async () => {
  const store = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (store.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
  const roots = [issue("TEAM-1", [], "alex"), issue("TEAM-2", [], "sam")];
  const parent = issue("TEAM-P", [], null);
  const calls = { parent: 0, body: 0, children: 0 };
  const tracker = {
    adapter: "jira",
    team: "TEAM",
    stateName: (state: string) => (state === "todo" ? "Todo" : null),
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    listRelations: async () => [],
    getIssue: async (key: string) => {
      if (key === "TEAM-P") calls.body++;
      return {
        identifier: key,
        description: "",
        parent: key === "TEAM-P" ? null : { identifier: "TEAM-P" },
      };
    },
    dispatchSource: {
      credential: async () => "credential",
      queue: async (identity: string) =>
        roots
          .filter((row) => row.assignee?.name === identity)
          .map((value) => ({ identifier: value.identifier, value })),
      issue: async (key: string) => {
        if (key === "TEAM-P") calls.parent++;
        return { identifier: key, value: parent, parent: null };
      },
      children: async () => {
        calls.children++;
        return [];
      },
      project: async (raw: { value: unknown }) => raw.value as PoolIssue,
    },
  } as unknown as Tracker;
  const people = ["alex", "sam"].map((name) => ({
    name,
    forge: [name],
    tracker: { jira: name },
  }));
  const views: ServedViews = new Map();
  const reading = await readServedPickups(tracker, people, {
    cache,
    views,
    nowMs: 100000,
    headroom: true,
  });
  expect(reading.wanted.map((row) => row.key)).toEqual(["TEAM-1", "TEAM-2"]);
  expect(calls.parent).toBe(1);
  expect(calls.body).toBe(1);
  const options = { nowMs: 100000, headroom: true };
  const a = await sharedView(views, tracker, "alex", options, cache);
  const b = await sharedView(views, tracker, "sam", options, cache);
  await Promise.all(
    [a, b].map((view) =>
      view.once(
        "native children TEAM-P",
        async () => (await tracker.dispatchSource?.children("TEAM-P")) ?? [],
      ),
    ),
  );
  expect(calls.children).toBe(1);
});

it("does not send another person's queue after its scope fails", async () => {
  let calls = 0;
  const tracker = {
    adapter: "linear",
    team: "TEAM",
    stateName: () => null,
    dispatchSource: {
      credential: async () => "credential",
      queue: async () => {
        calls++;
        throw new Error("scope unreachable");
      },
      project: async (raw: { value: unknown }) => raw.value as PoolIssue,
    },
  } as unknown as Tracker;
  const cache = { get: () => null, set: () => undefined };
  const views: ServedViews = new Map();
  const first = await sharedView(
    views,
    tracker,
    "alex",
    { nowMs: 100000, headroom: true },
    cache,
  );
  const next = await sharedView(
    views,
    tracker,
    "sam",
    { nowMs: 100000, headroom: true },
    cache,
  );
  expect(first.unavailable).toBe("scope unreachable");
  expect(next.unavailable).toBe("scope unreachable");
  expect(calls).toBe(1);
});

it("reports the kept queue age when offline projection needs uncached native metadata", async () => {
  const store = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (store.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
  let reads: Map<string, Promise<unknown>> | undefined;
  let metadata = 0;
  const row = issue("TEAM-1");
  const tracker = {
    adapter: "linear",
    team: "TEAM",
    stateName: (state: string) => (state === "todo" ? "Todo" : null),
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    changedSince: async () => {
      throw new Error("scope unreachable");
    },
    dispatchSource: {
      credential: async () => "credential",
      shareReads: (shared: Map<string, Promise<unknown>>) => {
        reads = shared;
      },
      queue: async () => [
        { identifier: row.identifier, value: row, parent: null, relations: [] },
      ],
      issue: async () => null,
      children: async () => [],
      project: async () => {
        await sharedDispatchRead(reads, "metadata", async () => {
          metadata++;
          return true;
        });
        return row;
      },
    },
  } as unknown as Tracker;
  const people = [
    { name: "Alex", forge: ["alex"], tracker: { linear: "alex" } },
  ];
  const initial = await readServedPickups(tracker, people, {
    cache,
    nowMs: 100000,
    headroom: true,
    views: new Map(),
  });
  expect(initial.wanted).toHaveLength(1);
  const next = await readServedPickups(tracker, people, {
    cache,
    nowMs: 160000,
    headroom: true,
    views: new Map(),
  });
  expect(next.incomplete).toBe(true);
  expect(next.unplaced).toContainEqual(
    expect.objectContaining({
      reason: expect.stringContaining(new Date(100000).toISOString()),
    }),
  );
  expect(metadata).toBe(1);
});
