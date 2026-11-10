/** Typed decision projections retain prose and model-driven optional details. */
import { expect, it } from "bun:test";
import { decisionOf } from "../lib/line-decision.ts";

it("reads typed parks without interpreting prose as fields", () => {
  const park = {
    key: "typed",
    kind: "finding" as const,
    lines: [],
    decision: {
      schema: "parked-decision/v1" as const,
      class: "scope",
      call: {
        id: "a",
        question: "Should we extend coverage?",
        recommended: "a",
        why: "It covers the failure",
        options: [
          {
            id: "a",
            name: "Extend",
            summary: "Costs: remains ordinary prose",
            pay: ["More work"],
            obligation: "Review coverage",
          },
          {
            id: "b",
            name: "Keep",
            summary: "Keep coverage",
            pay: ["Less assurance"],
          },
        ],
      },
      steps: [],
      alreadyDone: "Read coverage",
    },
  };
  const result = decisionOf(park);
  expect(result.question).toBe("Should we extend coverage?");
  expect(result.options?.[0]).toMatchObject({
    changes: "Costs: remains ordinary prose",
    costs: "More work",
    details: [{ label: "Obligation", text: "Review coverage" }],
  });
});
