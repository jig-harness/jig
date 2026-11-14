/**
 * The `closing-report/v1` check: each field's rules, the redaction applied
 * before it, a decision only beside its question, and the evidence forms
 * and their limit.
 */
import { describe, expect, it } from "bun:test";
import {
  checkClosingReport,
  closingReportOf,
  isClosingReport,
} from "../closing-report.ts";
import type { ParkedDecision } from "../decisions/park.ts";

const QUESTION = "Should the export keep the old column?";

const DECISION: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: QUESTION,
    options: [
      {
        id: "keep",
        name: "Keep it",
        summary: "The column stays.",
        pay: ["A wider export."],
      },
      {
        id: "drop",
        name: "Drop it",
        summary: "The column goes.",
        pay: ["Readers of it break."],
      },
    ],
    recommended: "keep",
    why: "Readers of the column still exist.",
  },
  steps: [],
  alreadyDone: "The scouts ran.",
};

const BASE = {
  schema: "closing-report/v1",
  concluded: "Opened #812 for the item; its drive is armed.",
  suggested_next: { step: "Drive #812 to convergence.", owner: "line" },
};

const problems = (value: unknown) => checkClosingReport(value);

describe("checkClosingReport", () => {
  it("takes the smallest report and a full one", () => {
    expect(problems(BASE)).toEqual([]);
    expect(
      problems({
        ...BASE,
        question: QUESTION,
        decision: DECISION,
        suggested_next: {
          step: "Answer the question.",
          owner: "person",
          act: "Decide",
        },
        cause: "needs-person",
        evidence: [
          "pr:#812",
          "commit:0123abc",
          "item:#55",
          "path:plugin/dispatch/cli.ts",
          "run:https://ci.example.test/runs/9",
        ],
      }),
    ).toEqual([]);
  });

  it("requires concluded and suggested_next, and names an unknown field", () => {
    const found = problems({ schema: "closing-report/v1", output: "x" });
    expect(found).toContain("$.concluded: is required");
    expect(found).toContain("$.suggested_next: is required");
    expect(found).toContain("$.output: unknown field");
    expect(problems({ ...BASE, schema: "closing-report/v2" })).toEqual([
      "$.schema: must be closing-report/v1",
    ]);
    expect(problems([])).toEqual(["$: must be an object"]);
  });

  it("holds concluded to 600 characters and the step to 300", () => {
    expect(problems({ ...BASE, concluded: "x".repeat(600) })).toEqual([]);
    expect(problems({ ...BASE, concluded: "x".repeat(601) })).toEqual([
      "$.concluded: must be at most 600 characters",
    ]);
    expect(problems({ ...BASE, concluded: " " })).toEqual([
      "$.concluded: must be a non-empty string",
    ]);
    expect(
      problems({
        ...BASE,
        suggested_next: { step: "y".repeat(301), owner: "none" },
      }),
    ).toEqual(["$.suggested_next.step: must be at most 300 characters"]);
  });

  it("takes a question of one line ending with ? of at most 1000 characters", () => {
    expect(problems({ ...BASE, question: "Keep it." })).toEqual([
      "$.question: must be one line ending with '?'",
    ]);
    expect(problems({ ...BASE, question: "Keep it?\nOr not?" })).toEqual([
      "$.question: must be one line ending with '?'",
    ]);
    expect(problems({ ...BASE, question: `${"q".repeat(999)}?` })).toEqual([]);
    expect(problems({ ...BASE, question: `${"q".repeat(1000)}?` })).toEqual([
      "$.question: must be at most 1000 characters",
    ]);
  });

  it("takes a decision only with its question, checked as a framed decision", () => {
    expect(problems({ ...BASE, decision: DECISION })).toEqual([
      "$.decision: is only for a report with a question",
    ]);
    expect(
      problems({ ...BASE, question: "Another question?", decision: DECISION }),
    ).toEqual(["$.question: must be the decision's call.question"]);
    const wrong = problems({
      ...BASE,
      question: QUESTION,
      decision: { ...DECISION, call: { ...DECISION.call, recomended: "x" } },
    });
    expect(wrong).toContain("$.decision.call.recomended: unknown field");
    expect(
      problems({
        ...BASE,
        question: QUESTION,
        decision: { ...DECISION, class: "pickup-recovery" },
      })[0],
    ).toContain("dispatcher's own framing");
  });

  it("asks for an act exactly when the owner is a person, from the closed list", () => {
    const next = (n: object) => problems({ ...BASE, suggested_next: n });
    expect(next({ step: "Merge it.", owner: "person" })).toEqual([
      "$.suggested_next.act: is required when the owner is person",
    ]);
    expect(next({ step: "Merge it.", owner: "person", act: "Ship" })).toEqual([
      "$.suggested_next.act: must be one of Merge, Decide, Authorize, Reply, Do, Investigate",
    ]);
    expect(next({ step: "Drive it.", owner: "line", act: "Merge" })).toEqual([
      "$.suggested_next.act: is only for an owner that is person",
    ]);
    expect(next({ step: "Wait.", owner: "nobody" })).toEqual([
      "$.suggested_next.owner: must be one of line, person, none",
    ]);
  });

  it("takes a cause only from the closed list", () => {
    for (const cause of [
      "needs-person",
      "refused",
      "tool-failed",
      "environment",
      "scope",
      "deadline",
      "startup",
      "usage-limit",
      "crashed",
      "unknown",
    ])
      expect(problems({ ...BASE, cause })).toEqual([]);
    expect(problems({ ...BASE, cause: "bored" })[0]).toStartWith(
      "$.cause: must be one of needs-person",
    );
  });

  it("takes at most 10 evidence references, each of a known form", () => {
    const refs = Array.from({ length: 10 }, (_, i) => `pr:#${i + 1}`);
    expect(problems({ ...BASE, evidence: refs })).toEqual([]);
    expect(problems({ ...BASE, evidence: [...refs, "pr:#11"] })).toEqual([
      "$.evidence: holds at most 10 references",
    ]);
    for (const bad of [
      "pr:12",
      "commit:XYZ",
      "path:/etc/passwd",
      "path:../outside",
      "path:C:\\x",
      "run:not-an-address",
      "path:a/../../b",
      "the whole log",
      "item:",
    ])
      expect(problems({ ...BASE, evidence: [bad] })[0]).toStartWith(
        "$.evidence[0]: must be",
      );
  });
});

describe("closingReportOf", () => {
  it("masks the exact launch token and bracketed secret values", () => {
    const token = "0123456789abcdef0123456789abcdef";
    const read = closingReportOf(
      JSON.stringify({
        ...BASE,
        concluded: `Used ${token} to record it; password=[hunter2] was set.`,
      }),
      token,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.concluded).not.toContain(token);
    expect(read.value.concluded).not.toContain("hunter2");
  });

  it("refuses a decision over its own byte limit and a null decision", () => {
    const big = { ...DECISION, alreadyDone: "x".repeat(9000) };
    const over = closingReportOf(
      JSON.stringify({ ...BASE, question: QUESTION, decision: big }),
    );
    expect(over.ok).toBe(false);
    const none = closingReportOf(
      JSON.stringify({ ...BASE, question: QUESTION, decision: null }),
    );
    expect(none.ok).toBe(false);
  });

  it("redacts emails and account identifiers before the check", () => {
    const read = closingReportOf(
      JSON.stringify({
        ...BASE,
        concluded:
          "Asked dev@example.test; account acct-0123456789abcdef and token:0123456789ab were in the way.",
        question: `Should dev@example.test answer?`,
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.concluded).toBe(
      "Asked <redacted>; account <redacted> and <redacted> were in the way.",
    );
    expect(read.value.question).toBe("Should <redacted> answer?");
  });

  it("redacts tokens and other credential-shaped values, leaving references alone", () => {
    const secrets = [
      "ghp_abcdefghijkl1234",
      "github_pat_11ABCDEFG0123456789_abcdefghij",
      "lin_api_abcdefghijkl0123",
      "sk-ant-abcdefghijkl0123",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "abcdefgh12345678",
    ];
    const read = closingReportOf(
      JSON.stringify({
        ...BASE,
        concluded: `Pushed with ${secrets[0]} and ${secrets[1]}; the tracker took ${secrets[2]}.`,
        suggested_next: {
          step: `Rotate ${secrets[3]}, ${secrets[4]} and Authorization: Bearer ${secrets[5]}.`,
          owner: "none",
        },
        evidence: [
          "commit:0123456789abcdef0123456789abcdef01234567",
          "path:plugin/dispatch/cli.ts",
        ],
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const kept = JSON.stringify(read.value);
    for (const secret of secrets) expect(kept).not.toContain(secret);
    expect(read.value.concluded).toBe(
      "Pushed with <redacted> and <redacted>; the tracker took <redacted>.",
    );
    expect(read.value.suggested_next.step).toStartWith(
      "Rotate <redacted>, <redacted> and Authorization",
    );
    expect(read.value.evidence).toEqual([
      "commit:0123456789abcdef0123456789abcdef01234567",
      "path:plugin/dispatch/cli.ts",
    ]);
  });

  it("refuses text that is not JSON, or over the size limit, naming why", () => {
    const notJson = closingReportOf("{nope");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.failure.reason).toContain("not JSON");
    const big = closingReportOf(
      JSON.stringify({ ...BASE, concluded: "x".repeat(20_000) }),
    );
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.failure.reason).toContain("bytes");
  });

  it("names every problem in one refusal", () => {
    const read = closingReportOf(
      JSON.stringify({ ...BASE, concluded: "", cause: "bored" }),
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.reason).toContain("$.concluded");
    expect(read.failure.reason).toContain("$.cause");
  });

  it("reads back as a report", () => {
    expect(isClosingReport(BASE)).toBe(true);
    expect(isClosingReport({ ...BASE, schema: "x" })).toBe(false);
  });
});
