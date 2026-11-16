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

function fixture() {
  const node = (number: number) =>
    issueNode({
      number,
      assignee: number === 1 ? "dana" : null,
      labels: ["Todo"],
      extra: { subIssues: conn([]) },
    });
  let duringBatch: (() => void) | undefined;
  const fake = gitHub(
    (call) => {
      if (call.op === "TrackerDispatchQueue")
        return { repository: { issues: conn([node(1)]) } };
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
  const views = reads.servedViews;
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
    open,
    tick,
    preload,
    duringBatch: (run: () => void) => {
      duringBatch = run;
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
  expect(
    f.calls.filter((call) => call.op === "TrackerDispatchIssues"),
  ).toHaveLength(5);
  expect(
    f.calls.filter((call) => call.op === "TrackerDispatchIssue"),
  ).toHaveLength(0);
  expect(f.calls[0]?.signal?.aborted).toBe(true);
  expect(f.calls.slice(1).every((call) => call.signal?.aborted === false)).toBe(
    true,
  );
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

it("gives shared native facts the tick bound", async () => {
  const f = fixture();
  const caller = new AbortController();
  const view = await f.open(caller.signal);

  expect(view.bound?.signal).toBe(f.tick.signal);
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
