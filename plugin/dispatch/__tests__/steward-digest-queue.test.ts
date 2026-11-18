import { describe, expect, spyOn, test } from "bun:test";
import { stewardQueue, stewardPasses } from "../lib/actions/steward.ts";
import type { ReadRecord } from "../lib/launches.ts";
import {
  readRoomMs,
  settleMs,
  type ApplyState,
} from "../lib/actions/launch.ts";
import type { Tracked } from "../lib/tick-tracker.ts";
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
    isEpic: false,
    truncated: [],
  };
}

test("the digest's historical passes keep output only for actual questions, bounded and token-redacted", () => {
  const records = [
    {
      record: {
        id: "quiet",
        repo: "example/repo",
        item: "#7",
        action: "pickup",
        token: "old-token",
      },
      state: { kind: "ended", exit: { context: "ordinary pass output" } },
    },
    {
      record: {
        id: "question",
        repo: "example/repo",
        pr: 8,
        action: "followup",
        token: "old-token",
      },
      state: {
        kind: "ended",
        exit: {
          said: "Question: Which option for old-token?",
          context: `${"x".repeat(9000)}\nQuestion: Which option for old-token?`,
        },
      },
    },
  ] as unknown as ReadRecord[];
  const passes = stewardPasses(records, "example/repo");
  expect(passes[0]).toMatchObject({
    record: "quiet",
    question: null,
    said: null,
  });
  expect(passes[1]?.question).toBe("Which option for [launch token]?");
  expect(passes[1]?.said?.length).toBeLessThanOrEqual(8000);
  expect(passes[1]?.said).toContain("[launch token]");
  expect(JSON.stringify(passes)).not.toContain("old-token");
});
test("the digest leaves out a pass a person decides or the tick already judged", () => {
  const ended = (id: string, extra: object = {}) => ({
    record: { id, repo: "example/repo", item: "#7", action: "pickup" },
    state: { kind: "ended", exit: { said: "Question: Which option?" } },
    ...extra,
  });
  const records = [
    ended("open"),
    ended("framed", { framed: { digest: "0".repeat(12) } }),
    ended("judged"),
  ] as unknown as ReadRecord[];
  expect(
    stewardPasses(records, "example/repo", new Set(["judged"])).map(
      (p) => p.record,
    ),
  ).toEqual(["open"]);
});
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
    expect(Date.now() - started).toBeLessThan(500);
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

describe("the steward's digest reads", () => {
  test("the read room reserves an identity check for every account admission may try", () => {
    // A frozen clock, so only the account-dependent reserve moves the room.
    const clock = spyOn(Temporal.Now, "instant").mockImplementation(() =>
      Temporal.Instant.fromEpochMilliseconds(1_000_000),
    );
    const roomWith = (accounts: number): number | null =>
      readRoomMs({
        machine: {
          runtimeTimeoutMs: 30_000,
          workspaceTimeoutMs: 60_000,
          opensPerTick: 2,
          followupOpensPerTick: 0,
          repositories: [],
          accounts: Array.from({ length: accounts }, () => ({})),
        },
        startedAt: 1_000_000,
      } as unknown as ApplyState);
    try {
      const one = roomWith(1) ?? Number.NaN;
      const three = roomWith(3) ?? Number.NaN;
      expect(one - three).toBe(settleMs(30_000, 2));
    } finally {
      clock.mockRestore();
    }
  });
});
