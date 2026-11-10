import { describe, expect, it } from "bun:test";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { readServedPickups } from "../lib/sources/served.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import type { DispatchSection } from "../lib/types.ts";
import { renderExecutionPlan } from "../../skills/do-item/scripts/lib/execution-plan.ts";
import { rankQueue } from "../lib/queue-rank.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { issue } from "./served-fixtures.ts";
const people = [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }];
function fake() {
  const store = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
  const roots = [issue("#1", ["epic"]), issue("#4", ["hitl"]), issue("#5")];
  const children: Record<string, PoolIssue[]> = {
    "#1": [issue("#2", ["epic"], null)],
    "#2": [issue("#3", [], null)],
  };
  const calls: string[] = [];
  const tracker = {
    adapter: "github",
    team: "example/repo",
    assignedIssues: async (_: string, s: string[]) =>
      s.includes("in_progress") ? [] : roots,
    assignedBy: async (k: string) => {
      calls.push(`assigner ${k}`);
      return { id: "writer", name: "writer", trusted: true };
    },
    openChildren: async (k: string) => children[k] ?? [],
    listRelations: async (k: string) => {
      calls.push(`relations ${k}`);
      return k === "#5" ? [{ type: "blocked_by", issue: "#9" }] : [];
    },
    poolIssue: async (k: string) =>
      [...roots, ...Object.values(children).flat()].find(
        (i) => i.identifier === k,
      ) ?? issue(k),
    getIssue: async (k: string) => ({ identifier: k, description: "" }),
  } as unknown as Tracker;
  return { tracker, cache, calls };
}
describe("served pickups", () => {
  it("carries configured human labels and plan blocks through the public reader", async () => {
    const f = fake();
    const description =
      "## Execution Plan\n" +
      renderExecutionPlan({
        epic: "#1",
        intent: "deliver",
        steps: [{ issue: "#5", band: 1, lane: "one", gate: "human" }],
        edges: [],
        gates: [],
      }).replaceAll("execution-plan-v1", "custom-plan");
    f.tracker.assignedIssues = async (_, states) =>
      states.includes("in_progress")
        ? []
        : [issue("#4", ["person-check:legal"]), issue("#5")];
    f.tracker.getIssue = async (key: string) =>
      ({
        identifier: key,
        description: key === "#1" ? description : "",
        parent: key === "#5" ? { identifier: "#1" } : null,
      }) as Awaited<ReturnType<Tracker["getIssue"]>>;
    f.tracker.listRelations = async () => [];
    const read = await readPickups(
      () => f.tracker,
      { identity: null } as DispatchSection,
      undefined,
      {
        people,
        cache: f.cache,
        nowMs: 1,
        headroom: true,
        hitl: "person-check",
        executionPlanBlock: "custom-plan",
      },
    );
    expect(read.wanted).toEqual([]);
    for (const key of ["#4", "#5"])
      expect(read.unplaced).toContainEqual(
        expect.objectContaining({
          target: key,
          reason: "needs a person to start",
        }),
      );
  });
  it("keeps a directly assigned child behind its parent's human gate", async () => {
    const f = fake();
    const description =
      "## Execution Plan\n" +
      renderExecutionPlan({
        epic: "#1",
        intent: "deliver",
        steps: [{ issue: "#5", band: 1, lane: "one", gate: "human" }],
        edges: [],
        gates: [],
      });
    f.tracker.getIssue = async (key: string) =>
      ({
        identifier: key,
        description: key === "#1" ? description : "",
        parent: key === "#5" ? { identifier: "#1" } : null,
      }) as Awaited<ReturnType<Tracker["getIssue"]>>;
    f.tracker.listRelations = async () => [];
    const read = await readServedPickups(f.tracker, people, {
      cache: f.cache,
      epic: "epic",
      nowMs: 1,
      headroom: true,
    });
    expect(read.wanted.some((i) => i.key === "#5")).toBe(false);
    expect(read.unplaced).toContainEqual(
      expect.objectContaining({
        target: "#5",
        reason: "needs a person to start",
      }),
    );
  });
  it("holds an epic whose full description cannot be read", async () => {
    const f = fake();
    f.tracker.getIssue = async () => null;
    const read = await readServedPickups(f.tracker, people, {
      cache: f.cache,
      epic: "epic",
      nowMs: 1,
      headroom: true,
    });
    expect(read.wanted.some((i) => i.key === "#3")).toBe(false);
    expect(read.unplaced).toContainEqual(
      expect.objectContaining({
        target: "#1",
        reason: "the epic description cannot be read",
      }),
    );
  });
  it("walks nested epic children and reports blocked and human work", async () => {
    const f = fake();
    const read = await readServedPickups(f.tracker, people, {
      cache: f.cache,
      epic: "epic",
      nowMs: 1,
      headroom: true,
    });
    expect(read.wanted.map((i) => i.key)).toContain("#3");
    expect(read.wanted.find((i) => i.key === "#3")?.ancestorEpic).toBe("#1");
    expect(read.unplaced).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "#4",
          reason: "needs a person to start",
        }),
        expect.objectContaining({ target: "#5", reason: "waiting on #9" }),
      ]),
    );
  });
  it("keeps the title and link the listing returned on an item it cannot place and on a claimed item", async () => {
    const f = fake();
    const held = {
      ...issue("#4", ["hitl"]),
      title: "Sign off the copy",
      url: "https://forge.example/example/repo/issues/4",
    };
    const claimed = {
      ...issue("#8"),
      title: "Ship the export",
      url: "https://forge.example/example/repo/issues/8",
    };
    f.tracker.assignedIssues = async (_: string, s: readonly string[]) =>
      s.includes("in_progress") ? [claimed] : [held];
    const read = await readServedPickups(f.tracker, people, {
      cache: f.cache,
      epic: "epic",
      nowMs: 1,
      headroom: true,
    });
    expect(read.unplaced).toContainEqual({
      target: "#4",
      title: "Sign off the copy",
      url: "https://forge.example/example/repo/issues/4",
      record: "tracker",
      reason: "needs a person to start",
    });
    expect(read.claimed).toContainEqual(
      expect.objectContaining({
        key: "#8",
        url: "https://forge.example/example/repo/issues/8",
      }),
    );
  });
  it("keeps metadata at the same updatedAt", async () => {
    const f = fake();
    await readServedPickups(f.tracker, people, {
      cache: f.cache,
      epic: "epic",
      nowMs: 1,
      headroom: true,
    });
    f.calls.length = 0;
    await readServedPickups(f.tracker, people, {
      cache: f.cache,
      epic: "epic",
      nowMs: 2,
      headroom: true,
    });
    expect(f.calls).toEqual([]);
  });
  it("orders urgent and unblocking work before smaller newer work", () => {
    const a = { issue: issue("#1"), blockers: [], unblocks: 0 };
    const b = {
      issue: { ...issue("#2"), priority: 1 },
      blockers: [],
      unblocks: 0,
    };
    expect(rankQueue([a, b]).map((i) => i.issue.identifier)).toEqual([
      "#2",
      "#1",
    ]);
  });
});
