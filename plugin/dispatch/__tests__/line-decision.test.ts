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

it("carries the framing's digest and the time it was parked, so a page can tell a park made again", () => {
  const park = {
    key: "PRRT_a",
    kind: "thread" as const,
    lines: ["A sentence from before parks were framed."],
    digest: "3fa9c2d1e0b4",
    parkedAt: "2026-11-03T07:05:00.000Z",
  };
  expect(decisionOf(park)).toMatchObject({
    digest: "3fa9c2d1e0b4",
    parkedAt: "2026-11-03T07:05:00.000Z",
  });
  const { parkedAt: _parkedAt, ...older } = park;
  expect("parkedAt" in decisionOf(older)).toBe(false);
});
