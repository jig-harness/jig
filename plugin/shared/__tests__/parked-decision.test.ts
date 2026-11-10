import { expect, test } from "bun:test";
import {
  checkParkedDecision,
  renderParkedDecision,
  type ParkedDecision,
} from "../decisions/park.ts";

const decision: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "escalated",
  call: {
    id: "a",
    question: "Keep the current value?",
    options: [
      { id: "a", name: "Keep", summary: "Keep it.", pay: ["Concern stays."] },
      {
        id: "b",
        name: "Change",
        summary: "Change it.",
        pay: ["Review again."],
        reversible: false,
      },
    ],
    recommended: "a",
    why: "Matches the current contract.",
  },
  steps: [],
  alreadyDone: "Read the contract.",
};
test("recommendation must be a string, never a coercible JSON value", () => {
  for (const recommended of [1, ["1"]]) {
    const call = {
      ...decision.call,
      options: decision.call.options.map((o, i) => ({
        ...o,
        id: String(i + 1),
      })),
      recommended,
    };
    expect(
      checkParkedDecision({ ...decision, call }, "escalated").join(" "),
    ).toContain("$.call.recommended");
  }
});
test("strict JSON paths name misspelt fields without interpreting text as labels", () => {
  expect(checkParkedDecision(decision, "escalated")).toEqual([]);
  expect(
    checkParkedDecision({ ...decision, alredyDone: "typo" }, "escalated"),
  ).toContain("$.alredyDone: unknown field");
  expect(
    checkParkedDecision({ ...decision, class: "legal" }, "escalated").join(" "),
  ).toContain("--class");
  const rendered = renderParkedDecision(decision);
  expect(rendered).toContain("Reversible: No");
});
test("all option and recommendation invariants survive JSON", () => {
  const call = {
    ...decision.call,
    question: "Two\nlines?",
    recommended: "missing",
    why: "short",
    options: [decision.call.options[0], decision.call.options[0]],
  };
  const problems = checkParkedDecision({ ...decision, call }, "escalated").join(
    "\n",
  );
  for (const text of [
    "one line",
    "duplicate id",
    "share a name",
    "recommended",
    "why",
  ])
    expect(problems).toContain(text);
});
