/**
 * An epic whose execution plan holds a child no rule will release raises
 * one need for a person, and the children it holds name that need; a plan
 * step waiting on its predecessors names the predecessor instead.
 */
import { describe, expect, it } from "bun:test";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  renderExecutionPlan,
  type ExecutionPlan,
} from "../../skills/do-item/scripts/lib/execution-plan.ts";
import { readServedPickups } from "../lib/sources/served.ts";
import { dropRepeatedItemNeeds } from "../lib/sources/served-repo.ts";
import { buildLine } from "../lib/line.ts";
import { personAct } from "../../ask/lib/waiting.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import type { Unplaced } from "../lib/types.ts";
import { issue } from "./served-fixtures.ts";
import { input, report } from "./line-fixtures.ts";

const people = [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }];

function plan(fields: Partial<ExecutionPlan> = {}): string {
  return `## Execution Plan\n${renderExecutionPlan({
    epic: "#1",
    intent: "deliver",
    steps: [
      { issue: "#2", band: 1, lane: "a", gate: "agent" },
      { issue: "#3", band: 2, lane: "b", gate: "agent" },
    ],
    edges: [],
    gates: [],
    ...fields,
  })}`;
}

/** A tracker with the epic #1 assigned to Alex, its open children and its description. */
function tracker(description: string, children: PoolIssue[]): Tracker {
  const epic = issue("#1", ["epic"]);
  const all = [epic, ...children];
  return {
    adapter: "github",
    team: "example/repo",
    stateName: (s: string) => (s === "pr_open" ? null : s),
    assignUnassigned: async () => ({ assigned: true }),
    assignedIssues: async (_: string, states: string[]) =>
      states.includes("in_progress") ? [] : [epic],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    openChildren: async (key: string) => (key === "#1" ? children : []),
    listRelations: async () => [],
    poolIssue: async (key: string) =>
      all.find((i) => i.identifier === key) ?? null,
    getIssue: async (key: string) => ({
      identifier: key,
      description: key === "#1" ? description : "",
      parent: key === "#1" ? null : { identifier: "#1" },
    }),
  } as unknown as Tracker;
}

function cache(): PickupReads {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
}

async function read(description: string, children: PoolIssue[]) {
  return readServedPickups(tracker(description, children), people, {
    cache: cache(),
    nowMs: 1,
    headroom: true,
  });
}

const needsOf = (unplaced: readonly Unplaced[]) =>
  unplaced.filter((u) => u.cause === "epic-plan");
const reasonOf = (unplaced: readonly Unplaced[], target: string) =>
  unplaced.find((u) => u.target === target && u.cause === undefined)?.reason;

const child = (key: string, started = false): PoolIssue => ({
  ...issue(key, [], null),
  ...(started
    ? { state: { id: "s", name: "In Progress", type: "started" } }
    : {}),
});

describe("an epic plan that cannot be applied", () => {
  it("raises one need naming the epic, and its children's Queue lines name that need", async () => {
    const got = await read("## Execution Plan\nno block here", [
      child("#2"),
      child("#3"),
    ]);
    expect(got.wanted).toEqual([]);
    const needs = needsOf(got.unplaced);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ target: "#1", record: "tracker" });
    expect(needs[0]?.reason).toContain("machine-readable block");
    expect(needs[0]?.reason).toContain(
      "re-run the planner on it, or remove its Execution Plan section",
    );
    for (const key of ["#2", "#3"])
      expect(reasonOf(got.unplaced, key)).toBe(
        "#1's execution plan cannot be applied (Execution Plan lacks its machine-readable block; re-run the planner), so it waits on the need raised on #1 for a person",
      );
  });

  it("raises the need for a plan written for another epic", async () => {
    const got = await read(plan({ epic: "#9" }), [child("#2")]);
    const needs = needsOf(got.unplaced);
    expect(needs).toHaveLength(1);
    expect(needs[0]?.reason).toContain("belongs to a different epic");
  });
});

describe("a child the plan does not name", () => {
  it("is reported as not in the plan, and the epic raises one need", async () => {
    const got = await read(plan(), [child("#2"), child("#3"), child("#4")]);
    expect(got.wanted.map((w) => w.key)).toEqual(["#2", "#3"]);
    expect(reasonOf(got.unplaced, "#4")).toBe(
      "not in #1's execution plan, so it waits on the need raised on #1 for a person",
    );
    const needs = needsOf(got.unplaced);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ target: "#1", cause: "epic-plan" });
    expect(needs[0]?.reason).toContain(
      "does not name 1 open child (#4), so it does not start",
    );
  });

  it("raises the need for a child assigned on its own, whose epic is not walked", async () => {
    const t = tracker(plan(), [child("#2"), child("#3")]);
    t.assignedIssues = async (_, states) =>
      states.includes("in_progress") ? [] : [issue("#4")];
    const got = await readServedPickups(t, people, {
      cache: cache(),
      nowMs: 1,
      headroom: true,
    });
    expect(got.wanted).toEqual([]);
    expect(reasonOf(got.unplaced, "#4")).toBe(
      "not in #1's execution plan, so it waits on the need raised on #1 for a person",
    );
    expect(needsOf(got.unplaced)).toMatchObject([
      { target: "#1", cause: "epic-plan" },
    ]);
  });

  it("raises no need for a child already in progress, which the plan does not stop", async () => {
    const got = await read(plan(), [
      child("#2"),
      child("#3"),
      child("#4", true),
    ]);
    expect(needsOf(got.unplaced)).toEqual([]);
  });

  it("raises no need when the plan names every open child", async () => {
    const got = await read(plan(), [child("#2"), child("#3")]);
    expect(needsOf(got.unplaced)).toEqual([]);
  });
});

describe("a plan step waiting on its predecessors", () => {
  it("names the predecessor in progress it waits on, and raises no need", async () => {
    const description = plan({
      edges: [
        {
          from: "#2",
          to: "#3",
          kind: "dependency",
          reason: "builds on it",
          completion: "done",
        },
      ],
    });
    const got = await read(description, [child("#2", true), child("#3")]);
    expect(reasonOf(got.unplaced, "#3")).toBe(
      "waiting on #2 (in progress), which the epic execution plan puts before it",
    );
    expect(needsOf(got.unplaced)).toEqual([]);
  });
});

describe("the epic's need on the line", () => {
  const need: Unplaced = {
    target: "#1",
    record: "tracker",
    reason: "its execution plan cannot be applied",
    cause: "epic-plan",
  };

  it("is a need for the epic, not a second Queue line beside its summary", () => {
    const summary: Unplaced = {
      target: "#1",
      record: "tracker",
      reason: "none of its 2 open children can start",
    };
    const line = buildLine(
      input({ reports: [report({ unplaced: [summary, need] })] }),
    );
    expect(line.needs).toHaveLength(1);
    expect(line.needs[0]).toMatchObject({
      cause: "epic-plan",
      act: "Do",
      stage: "pickup",
      item: "#1",
      reason: need.reason,
    });
    expect(line.queue.map((q) => q.why)).toEqual([summary.reason]);
    expect(personAct("epic-plan")).toBe(
      "re-run the epic's planner or remove its plan",
    );
  });

  it("is reported once across repositories that read the same tracker", () => {
    const reports = [{ unplaced: [need] }, { unplaced: [{ ...need }] }];
    dropRepeatedItemNeeds(reports);
    expect(reports.map((r) => r.unplaced.length)).toEqual([1, 0]);
  });
});
