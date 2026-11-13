import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySteward, stewardQueue } from "../lib/actions/steward.ts";
import {
  readRoomMs,
  settleMs,
  type ApplyState,
} from "../lib/actions/launch.ts";
import { keepStewardRun, type StewardDigest } from "../lib/steward.ts";
import { closeStateDb } from "../lib/state.ts";
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
    isEpic: false,
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

function digest(repo: string): StewardDigest {
  return {
    version: 1,
    repo,
    drives: [],
    needs: [],
    queue: [],
    passes: [],
    failures: [],
    load: null,
  };
}

describe("the scheduler reads nothing before cadence and cap rule a run out", () => {
  const roots: string[] = [];
  const freshRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "steward-order-"));
    roots.push(root);
    return root;
  };
  afterAll(() => {
    closeStateDb();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function stateAt(root: string): Parameters<typeof applySteward>[0] {
    return {
      root,
      records: [],
      machine: { steward: { enabled: true, everyMs: 1_200_000 } },
    } as unknown as Parameters<typeof applySteward>[0];
  }
  function observation(): Parameters<typeof applySteward>[1] {
    return {
      forge: { ok: true },
      opened: {
        owner: true,
        stages: new Set(["steward"]),
        repo: { slug: "example-org/order" },
        report: { launches: [], records: [] },
      },
    } as unknown as Parameters<typeof applySteward>[1];
  }
  test("an unelapsed cadence reads no digest", async () => {
    const root = freshRoot();
    keepStewardRun(
      "recent",
      digest("example-org/order"),
      Date.now() - 1_000,
      root,
    );
    let reads = 0;
    const seen = observation();
    await applySteward(stateAt(root), seen, async () => {
      reads++;
      throw new Error("digest read");
    });
    expect(reads).toBe(0);
    expect(seen.opened.report.steward?.status).toContain("cadence");
  });
  test("a spent host-wide hourly cap reads no digest", async () => {
    // Its own root: the repository has no run, so only the host-wide cap can stop it.
    const root = freshRoot();
    for (const i of [1, 2, 3])
      keepStewardRun(
        `other-${i}`,
        digest(`example-org/other-${i}`),
        Date.now() - 1_000,
        root,
      );
    let reads = 0;
    const seen = observation();
    await applySteward(stateAt(root), seen, async () => {
      reads++;
      throw new Error("digest read");
    });
    expect(reads).toBe(0);
    expect(seen.opened.report.steward?.status).toBe(
      "the host's hourly steward budget is spent",
    );
  });

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
