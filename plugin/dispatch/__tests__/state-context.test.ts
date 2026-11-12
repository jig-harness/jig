import { expect, it } from "bun:test";
import { defaultStateNames } from "../../skills/do-item/scripts/lib/tracker/config.ts";
import {
  workingStates,
  type StateContext,
  type Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { freshServedPickup, readServedPickups } from "../lib/sources/served.ts";
import { issue } from "./served-fixtures.ts";
import { assignPickup, type AssignTracker } from "../lib/requests.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import type { DispatchSection } from "../lib/types.ts";

const base = defaultStateNames();
const story = { ...base, blocked: "Story Hold", pr_open: "Story PR" };
const native = (context?: StateContext) =>
  typeof context === "string" ? context : context?.nativeType;

it("includes a type's separate PR state in claimed populations", () => {
  const tracker = {
    stateName: (state: keyof typeof base, context?: StateContext) =>
      (native(context) === "Story" ? story : base)[state],
    stateMaps: () => [base, story],
  } as unknown as Tracker;
  expect(workingStates(tracker)).toEqual(["in_progress", "pr_open"]);
  expect(workingStates(tracker, "Story")).toEqual(["in_progress", "pr_open"]);
  expect(workingStates(tracker, "Task")).toEqual(["in_progress"]);
});

it("never serves a type-specific blocked item, including fresh launch checks", async () => {
  const held = {
    ...issue("ENG-1"),
    nativeType: "Story",
    state: { id: "hold", name: "Story Hold", type: "unstarted" },
  };
  const tracker = {
    adapter: "jira",
    team: "ENG",
    stateName: (state: keyof typeof base, context?: StateContext) =>
      (native(context) === "Story" ? story : base)[state],
    stateMaps: () => [base, story],
    assignedIssues: async (_identity: string, states: string[]) =>
      states.includes("in_progress") ? [] : [held],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    poolIssue: async () => held,
    listRelations: async () => [],
    getIssue: async () => ({
      identifier: "ENG-1",
      description: "",
      parent: null,
    }),
  } as unknown as Tracker;
  expect(await freshServedPickup(tracker, "ENG-1", "alex")).toBe(
    "the served item is no longer open and not started",
  );
  const result = await readServedPickups(
    tracker,
    [{ name: "Alex", forge: ["alex"], tracker: { jira: "alex" } }],
    { epic: "epic", nowMs: 1, headroom: true },
  );
  expect(result.wanted).toEqual([]);
});

it("refuses an assignment whose dispatch target is absent from the item's workflow", async () => {
  const writes: string[] = [];
  const tracker = {
    user: async () => ({ id: "factory", name: "factory" }),
    assignees: async () => [],
    getIssue: async () => ({
      nativeType: "Epic",
      state: { name: "Ready", type: "unstarted" },
    }),
    stateName: () => null,
    transition: async () => {
      writes.push("transition");
    },
    assign: async () => {
      writes.push("assign");
    },
  } as unknown as AssignTracker;
  const result = await assignPickup(
    tracker,
    "ENG-1",
    "factory",
    "todo",
    () => "todo",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.reason).toContain("has no todo state");
  expect(writes).toEqual([]);
});

it("watches a type's PR state without counting another type's shared review state as claimed", async () => {
  const task = { ...base, pr_open: base.in_review };
  const tracker = {
    adapter: "jira",
    team: "ENG",
    stateName: (state: keyof typeof base, context?: StateContext) =>
      (native(context) === "Story"
        ? story
        : native(context) === "Task"
          ? task
          : base)[state],
    stateMaps: () => [base, story, task],
    assignedIssues: async (_identity: string, states: string[]) =>
      states.includes("pr_open")
        ? [
            {
              ...issue("ENG-1"),
              nativeType: "Story",
              state: { id: "pr", name: "Story PR", type: "started" },
            },
            {
              ...issue("ENG-2"),
              nativeType: "Task",
              state: { id: "review", name: "In Review", type: "started" },
            },
          ]
        : [],
  } as unknown as Tracker;
  const result = await readPickups(() => tracker, {
    identity: "factory",
    states: ["todo"],
  } as DispatchSection);
  expect(result.claimed?.map((item) => item.key)).toEqual(["ENG-1"]);
});
