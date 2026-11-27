import { expect, test } from "bun:test";
import { renderExecutionPlan } from "../../skills/do-item/scripts/lib/execution-plan.ts";
import { servedPlan } from "../lib/sources/served-plan.ts";

test("execution plans retain human checkpoints and dependency order", () => {
  const description =
    "## Execution Plan\n" +
    renderExecutionPlan({
      epic: "#1",
      intent: "deliver",
      steps: [
        { issue: "#2", band: 1, lane: "a", gate: "human" },
        { issue: "#3", band: 2, lane: "b", gate: "agent" },
      ],
      edges: [
        {
          from: "#2",
          to: "#3",
          kind: "dependency",
          reason: "needs it",
          completion: "done",
        },
      ],
      gates: [],
    });
  expect(
    servedPlan(description, "#1", {
      "#2": { state: "unstarted", blockedBy: [] },
      "#3": { state: "unstarted", blockedBy: [] },
    }),
  ).toEqual({
    present: true,
    order: ["#2"],
    holds: {
      "#2": "needs a person to start",
      "#3": "waiting on #2 (not started), which the epic execution plan puts before it",
    },
    steps: ["#2", "#3"],
  });
  expect(servedPlan("## Execution Plan\nmissing", "#1", {})).toMatchObject({
    present: true,
    error: expect.any(String),
  });
  expect(servedPlan("No plan", "#1", {})).toEqual({
    present: false,
    order: [],
    holds: {},
  });
  // The tracker says #2 waits for #3, the plan puts #2 first.
  expect(
    servedPlan(description, "#1", {
      "#2": { state: "unstarted", blockedBy: ["#3"] },
      "#3": { state: "unstarted", blockedBy: [] },
    }),
  ).toMatchObject({
    present: true,
    order: [],
    error: expect.stringContaining("#2 is blocked by #3 in the tracker"),
  });
});

test("a step waiting on its predecessors names each one and its state", () => {
  const description =
    "## Execution Plan\n" +
    renderExecutionPlan({
      epic: "#1",
      intent: "deliver",
      steps: ["#2", "#3", "#4", "#5"].map((issue, i) => ({
        issue,
        band: i + 1,
        lane: "a",
        gate: "agent" as const,
      })),
      edges: [
        {
          from: "#2",
          to: "#4",
          kind: "conflict",
          reason: "same files",
          completion: "merged",
          conflictSurfaceKinds: ["repository-files"],
          conflictFiles: ["a.ts"],
        },
        {
          from: "#3",
          to: "#4",
          kind: "dependency",
          reason: "needs it",
          completion: "done",
        },
      ],
      gates: [],
    });
  const selected = servedPlan(description, "#1", {
    "#2": { state: "completed", blockedBy: [] },
    "#3": { state: "started", blockedBy: [] },
    "#4": { state: "unstarted", blockedBy: [] },
    "#5": { state: "unstarted", blockedBy: ["#4"] },
  });
  expect(selected.order).toEqual(["#3"]);
  expect(selected.holds).toMatchObject({
    "#4": "waiting on #2 (done, until its merge is proven), #3 (in progress), which the epic execution plan puts before it",
    "#5": "waiting on #4 (not started), which the epic execution plan puts before it",
  });
});

test("a failed merge proof keeps every predecessor's reason beside the other waits", () => {
  const edge = (from: string, to: string, kind: "conflict" | "dependency") => ({
    from,
    to,
    kind,
    reason: "same files",
    completion: kind === "conflict" ? ("merged" as const) : ("done" as const),
    ...(kind === "conflict"
      ? { conflictSurfaceKinds: ["repository-files"], conflictFiles: ["a.ts"] }
      : {}),
  });
  const description =
    "## Execution Plan\n" +
    renderExecutionPlan({
      epic: "#1",
      intent: "deliver",
      steps: ["#2", "#3", "#4", "#5"].map((issue, i) => ({
        issue,
        band: i + 1,
        lane: "a",
        gate: "agent" as const,
      })),
      edges: [
        edge("#2", "#5", "conflict"),
        edge("#3", "#5", "conflict"),
        edge("#4", "#5", "dependency"),
      ],
      gates: [],
    });
  const live = {
    "#2": { state: "completed", blockedBy: [] },
    "#3": { state: "completed", blockedBy: [] },
    "#4": { state: "started", blockedBy: [] },
    "#5": { state: "unstarted", blockedBy: [] },
  };
  const { holds } = servedPlan(description, "#1", live, undefined, {
    merged: [],
    held: {
      "#2>#5": "waits on conflict edge #2 → #5: no merge",
      "#3>#5": "waits on conflict edge #3 → #5: unreadable",
    },
  });
  expect(holds["#5"]).toBe(
    "waiting on #4 (in progress), which the epic execution plan puts before it; waits on conflict edge #2 → #5: no merge; waits on conflict edge #3 → #5: unreadable",
  );
});
