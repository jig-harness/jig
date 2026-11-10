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
      "#3": "waiting on the epic execution plan",
    },
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
});
