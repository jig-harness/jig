import { expect, test } from "bun:test";
import { projectStewardNeed } from "../lib/steward-needs.ts";
import {
  routineRecommendation,
  resumablePickup,
} from "../lib/steward-resume-policy.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { Action } from "../lib/types.ts";

const action = (): Action => ({
  stage: "notify",
  target: "#12",
  cause: "pickup-question",
  record: "runtime",
  reason: "The pass needs an answer",
  evidence: { question: "Which file name?", record: "launch" },
});
const record = {
  kind: "need" as const,
  target: "#12",
  act: "Reply" as const,
  ask: "Choose a file name.",
  reason: "Neither option was recommended.",
};

test("framing projects onto each continuing tick and preserves the original question", () => {
  const source = [action()];
  for (let n = 0; n < 2; n++) {
    const next = action();
    projectStewardNeed([next], record, source);
    expect(next.evidence.stewardAct).toBe("Reply");
    expect(next.evidence.stewardAsk).toBe(record.ask);
    expect(next.evidence.question).toBe("Which file name?");
  }
  const changed = action();
  changed.evidence.question = "Which repository?";
  projectStewardNeed([changed], record, source);
  expect(changed.evidence.stewardAsk).toBeUndefined();
});

test("only an explicit affirmative option can resume, never a registry question", () => {
  expect(
    routineRecommendation(
      "Which file name?",
      "I recommend report.ts.\nQuestion: Which file name?",
    ),
  ).toBe("report.ts.");
  for (const output of [
    "No recommendation is available",
    "Recommended: none",
    "I do not recommend either",
    "Recommended: A\nRecommended: B",
    "## Class\nlegal\nRecommended: A",
    '{"schema":"parked-decision/v1"}\nRecommended: A',
  ])
    expect(routineRecommendation("Which file name?", output)).toBeNull();
  for (const question of [
    "[legal] Which option?",
    "May I release this?",
    "A database migration needs approval?",
  ])
    expect(
      routineRecommendation(question, "Recommended: A", [
        "legal",
        "release",
        "database-migration",
      ]),
    ).toBeNull();
});

test("a pickup cannot resume after closure, unreadable state or a configured hold", () => {
  const issue: PoolIssue = {
    identifier: "#12",
    title: "Task",
    url: null,
    priority: 2,
    type: "task",
    size: "small",
    createdAt: "2026-01-01",
    state: { id: "s", name: "In progress", type: "started" },
    assignee: { id: "a", name: "alex" },
    labels: [],
    isEpic: false,
    hasOpenChildren: false,
    truncated: [],
  };
  expect(resumablePickup(issue)).toBe(true);
  for (const state of ["completed", "canceled", "duplicate", ""])
    expect(
      resumablePickup({ ...issue, state: { ...issue.state, type: state } }),
    ).toBe(false);
  for (const labels of [
    ["person-required:legal"],
    ["manual-work"],
    ["jig:hold"],
  ])
    expect(
      resumablePickup(
        { ...issue, labels },
        { hitl: "person-required", manualOps: "manual-work" },
      ),
    ).toBe(false);
  expect(resumablePickup({ ...issue, truncated: ["labels"] })).toBe(false);
  expect(resumablePickup({ ...issue, assignee: null })).toBe(false);
});
