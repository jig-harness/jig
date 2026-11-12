import { describe, expect, test } from "bun:test";
import { stewardQueue } from "../lib/actions/steward.ts";
import type { Tracked } from "../lib/tick-observe.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { WantedItem } from "../lib/types.ts";

function issue(key: string): PoolIssue {
  return {
    identifier: key,
    title: "Task",
    url: null,
    type: "task",
    priority: 2,
    size: "small",
    state: { id: "todo", name: "Todo", type: "unstarted" },
    createdAt: "2026-01-01",
    assignee: { id: "a", name: "alex" },
    labels: [],
    hasOpenChildren: false,
    truncated: [],
  };
}
function item(key: string, observed: boolean): WantedItem {
  return {
    key,
    title: "Task",
    url: null,
    state: "Todo",
    assignee: "alex",
    assignedBy: "writer",
    ...(observed ? { queueIssue: issue(key) } : {}),
  };
}
function tracked(
  pickups: WantedItem[],
  read: (key: string, signal?: AbortSignal) => Promise<PoolIssue | null>,
): { tracked: Pick<Tracked, "pickups" | "tracker">; reads: string[] } {
  const reads: string[] = [];
  const tracker = {
    poolIssue: (key: string, signal?: AbortSignal) => {
      reads.push(key);
      return read(key, signal);
    },
  } as unknown as NonNullable<Tracked["tracker"]>;
  return { tracked: { pickups, tracker }, reads };
}

describe("the steward's queue", () => {
  test("reuses what the observe phase read and reads only the rest", async () => {
    const t = tracked([item("#1", true), item("#2", false)], async (key) =>
      issue(key),
    );
    const queue = await stewardQueue(t.tracked, () => null);
    expect(t.reads).toEqual(["#2"]);
    expect(queue).toMatchObject({
      ok: true,
      value: [{ identifier: "#1" }, { identifier: "#2" }],
    });
  });
  test("stops reading once the tick has no room left before its launch", async () => {
    const t = tracked([item("#1", false), item("#2", false)], async (key) =>
      issue(key),
    );
    let left = 1;
    const queue = await stewardQueue(t.tracked, () => left--);
    expect(t.reads).toEqual(["#1"]);
    expect(queue).toMatchObject({
      ok: false,
      failure: { code: "out-of-time" },
    });
  });
  test("bounds each read by the room left, and a failed read is a reason, not a throw", async () => {
    const t = tracked([item("#1", false)], (_key, signal) => {
      const { promise, reject } = Promise.withResolvers<PoolIssue | null>();
      signal?.addEventListener("abort", () => reject(signal.reason));
      return promise;
    });
    const started = Date.now();
    const queue = await stewardQueue(t.tracked, () => 50);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(queue).toMatchObject({
      ok: false,
      failure: {
        code: "unread",
        reason: "the queued item #1 did not read for the steward's digest",
      },
    });
  });
  test("an item the tracker no longer has is left out", async () => {
    const t = tracked([item("#1", false)], async () => null);
    expect(await stewardQueue(t.tracked, () => null)).toEqual({
      ok: true,
      value: [],
    });
  });
});
