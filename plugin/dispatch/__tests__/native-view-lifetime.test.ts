import { expect, it } from "bun:test";
import assert from "node:assert/strict";
import {
  conn,
  gitHub,
  issueNode,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import { sharedView } from "../lib/sources/served-reads.ts";
import { tickReads } from "../lib/tick-reads.ts";
import { orcaRuntime } from "../lib/runtime/orca.ts";
import { currentMs } from "../../shared/time.ts";
import { metadata } from "../lib/sources/served-metadata.ts";
import { within } from "../lib/sources/bounded.ts";
import { OutboundError } from "../../shared/outbound/failure.ts";

function fixture() {
  const node = (number: number) =>
    issueNode({
      number,
      assignee: number === 1 ? "dana" : null,
      labels: ["Todo"],
      extra: { subIssues: conn([]) },
    });
  let duringBatch: (() => void) | undefined;
  let duringQueue: (() => void) | undefined;
  let duringChanges: (() => void) | undefined;
  const fake = gitHub(
    (call) => {
      if (call.op === "TrackerDispatchQueue") {
        duringQueue?.();
        return { repository: { issues: conn([node(1)]) } };
      }
      if (call.op === "TrackerDispatchChanges") {
        duringChanges?.();
        return { repository: { issues: conn([]) } };
      }
      if (call.op === "TrackerDispatchIssue")
        return { repository: { issue: node(Number(call.variables.number)) } };
      if (call.op === "TrackerDispatchIssues") {
        duringBatch?.();
        return Object.fromEntries(
          Object.keys(call.variables)
            .filter((key) => /^number\d+$/.test(key))
            .map((key) => [
              `i${key.slice(6)}`,
              { issue: node(Number(call.variables[key])) },
            ]),
        );
      }
      throw new Error(`unexpected fixture operation ${call.op}`);
    },
    {
      taxonomy: { types: ["feature"], sizes: ["small"] },
      issue_tracker: {
        facets: {
          type: { store: "label" },
          size: { store: "label" },
          priority: { store: "label" },
        },
      },
    },
  );
  assert(fake.t.dispatchSource);
  const tracker = {
    ...fake.t,
    dispatchSource: {
      ...fake.t.dispatchSource,
      credential: async () => "fixture-credential",
    },
  };
  const values = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string): T | null => (values.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
  const now = currentMs();
  const tick = new AbortController();
  const preload = new AbortController();
  const reads = tickReads(orcaRuntime(), undefined, {
    deadline: now + 300_000,
    signal: tick.signal,
  });
  assert(reads.servedViews);
  let views = reads.servedViews;
  const open = (signal: AbortSignal, shared = true) =>
    sharedView(
      shared ? views : undefined,
      tracker,
      "dana",
      { nowMs: now, headroom: true, bound: { deadline: now + 60_000, signal } },
      cache,
    );
  return {
    ...fake,
    tracker,
    cache,
    open,
    tick,
    preload,
    duringBatch: (run: () => void) => {
      duringBatch = run;
    },
    duringQueue: (run: () => void) => {
      duringQueue = run;
    },
    duringChanges: (run: () => void) => {
      duringChanges = run;
    },
    nextTick: () => {
      const next = tickReads(orcaRuntime(), undefined, {
        deadline: now + 300_000,
        signal: tick.signal,
      });
      assert(next.servedViews);
      views = next.servedViews;
    },
  };
}

it("continues bounded lazy issue batches after the successful prefetch allowance ends", async () => {
  const f = fixture();
  await f.open(f.preload.signal);
  f.preload.abort(new DOMException("The operation timed out.", "TimeoutError"));
  const caller = new AbortController();
  const view = await f.open(caller.signal);

  const rows = await Promise.all(
    Array.from({ length: 98 }, (_, i) => view.pool(`#${i + 2}`)),
  );
  expect(rows).toHaveLength(98);
  expect(rows.every((row) => row !== null)).toBe(true);
  const batches = f.calls.filter((call) => call.op === "TrackerDispatchIssues");
  expect(batches).toHaveLength(5);
  expect(
    f.calls.filter((call) => call.op === "TrackerDispatchIssue"),
  ).toHaveLength(0);
  expect(batches.every((call) => call.signal?.aborted === false)).toBe(true);
});

it("shares child transport after its first caller expires", async () => {
  const f = fixture();
  const initial = await f.open(f.preload.signal);
  const queued = await initial.pool("#1");
  const child = await f.tracker.dispatchSource.issue("#2");
  assert(queued && child);
  const issue = {
    ...queued,
    assignee: null,
    isEpic: true,
    hasOpenChildren: true,
  };
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  let reads = 0;
  f.tracker.getIssue = async () => null;
  f.tracker.dispatchSource.children = async (_key, bound) => {
    reads += 1;
    entered.resolve();
    assert(bound);
    assert(bound.signal && bound.deadline !== undefined);
    return within(
      complete.promise.then(() => [child]),
      { signal: bound.signal, deadline: bound.deadline },
    );
  };
  const caller = new AbortController();
  const first = await f.open(caller.signal);
  const reading = metadata(f.tracker, issue, "dana", f.cache, [], first);
  try {
    await entered.promise;
    caller.abort();
    await expect(reading).rejects.toThrow();
    const next = await f.open(new AbortController().signal);
    const result = metadata(f.tracker, issue, "dana", f.cache, [], next);
    complete.resolve();
    expect((await result).children.map((row) => row.identifier)).toEqual([
      "#2",
    ]);
    expect(reads).toBe(1);
    expect(next.unavailable).toBeUndefined();
  } finally {
    complete.resolve();
  }
});

it("starts no queued shared callbacks after the tick ends", async () => {
  const f = fixture();
  const view = await f.open(new AbortController().signal);
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<string>();
  let started = 0;
  const reads = Array.from({ length: 32 }, (_, index) =>
    view.once(`queued fact ${index}`, async () => {
      started += 1;
      entered.resolve();
      return complete.promise;
    }),
  );
  await entered.promise;
  const before = started;
  expect(before).toBeLessThan(reads.length);
  f.tick.abort();
  complete.resolve("done");
  const results = await Promise.allSettled(reads);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(started).toBe(before);
});

it("starts no queued shared callbacks after the scope fails", async () => {
  const f = fixture();
  const view = await f.open(new AbortController().signal);
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<string>();
  let started = 0;
  const reads = Array.from({ length: 32 }, (_, index) =>
    view.once(`failed scope fact ${index}`, async () => {
      started += 1;
      entered.resolve();
      return complete.promise;
    }),
  );
  await entered.promise;
  const before = started;
  expect(before).toBeLessThan(reads.length);
  complete.reject(new OutboundError("unreachable", "fixture read failed"));
  await Promise.allSettled(reads);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(started).toBe(before);
  expect(view.unavailable).toBeDefined();
  expect(f.tick.signal.aborted).toBe(false);
});

it.each(["pool", "raw", "once"] as const)(
  "starts no %s read for a caller whose own allowance ended",
  async (method) => {
    const f = fixture();
    await f.open(f.preload.signal);
    const caller = new AbortController();
    const view = await f.open(caller.signal);
    caller.abort();
    const before = f.calls.length;
    let callbacks = 0;
    assert(view.raw);
    const read =
      method === "pool"
        ? view.pool("#2")
        : method === "raw"
          ? view.raw("#2")
          : view.once("late fact", async () => {
              callbacks += 1;
              return "#2";
            });
    await expect(read).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    expect(callbacks).toBe(0);
  },
);

it("starts no lazy issue read once the shared tick ends", async () => {
  const f = fixture();
  await f.open(f.preload.signal);
  const view = await f.open(new AbortController().signal);
  f.tick.abort();
  const before = f.calls.length;
  await expect(view.pool("#2")).rejects.toThrow();
  expect(f.calls).toHaveLength(before);
});

it("refuses a later caller after the shared tick ends", async () => {
  const f = fixture();
  await f.open(f.preload.signal);
  f.tick.abort();
  const before = f.calls.length;
  await expect(f.open(new AbortController().signal)).rejects.toThrow();
  expect(f.calls).toHaveLength(before);
});

it("keeps a native view's public bound responsive to the caller allowance", async () => {
  const f = fixture();
  const caller = new AbortController();
  const view = await f.open(caller.signal);

  expect(view.bound?.signal.aborted).toBe(false);
  caller.abort();
  expect(view.bound?.signal.aborted).toBe(true);
});

it("keeps direct caller cancellation on an unshared transport read", async () => {
  const f = fixture();
  const caller = new AbortController();
  const view = await f.open(caller.signal, false);
  f.duringBatch(() => caller.abort());

  await expect(view.pool("#2")).rejects.toThrow();
  const batch = f.calls.find((call) => call.op === "TrackerDispatchIssues");
  expect(batch?.signal?.aborted).toBe(true);
});

it("keeps the initial shared queue read within the caller allowance", async () => {
  const f = fixture();
  const caller = new AbortController();
  f.duringQueue(() => caller.abort());

  await expect(f.open(caller.signal)).rejects.toThrow();
  const queue = f.calls.find((call) => call.op === "TrackerDispatchQueue");
  expect(queue?.signal?.aborted).toBe(true);
});

it("keeps the initial shared change probe within the caller allowance", async () => {
  const f = fixture();
  const first = await f.open(f.preload.signal);
  first.save();
  f.nextTick();
  const caller = new AbortController();
  f.duringChanges(() => caller.abort());

  await expect(f.open(caller.signal)).rejects.toThrow();
  const probe = f.calls.find((call) => call.op === "TrackerDispatchChanges");
  expect(probe?.signal?.aborted).toBe(true);
});

it("stops the remaining batch chunks when the shared tick ends in flight", async () => {
  const f = fixture();
  await f.open(f.preload.signal);
  const view = await f.open(new AbortController().signal);
  f.duringBatch(() => f.tick.abort());

  await expect(
    Promise.all(Array.from({ length: 98 }, (_, i) => view.pool(`#${i + 2}`))),
  ).rejects.toThrow();
  expect(
    f.calls.filter((call) => call.op === "TrackerDispatchIssues"),
  ).toHaveLength(1);
  expect(
    f.calls.filter((call) => call.op === "TrackerDispatchIssue"),
  ).toHaveLength(0);
});
