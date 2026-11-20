/**
 * drive-pr: the closing report `drive.ts` composes at its stop
 * (`lib/driver/closing-report.ts`): the 600-character `concluded`, the
 * registry's cause and next step, and a park's question and framed decision.
 */
import { describe, expect, test } from "bun:test";
import {
  CONCLUDED_MAX,
  checkClosingReport,
  type ClosingReport,
} from "../../../shared/closing-report.ts";
import type { ParkedDecision } from "../../../shared/decisions/park.ts";
import { driverRuntime } from "../scripts/lib/driver/runtime.ts";
import {
  composeConcluded,
  composeDriverReport,
  cutTo,
  writeClosingReport,
} from "../scripts/lib/driver/closing-report.ts";
import { type DriveState, freshState } from "../scripts/lib/state/schema.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";
import { parkRecord } from "./park-record-fixture.ts";

const chars = (text: string) => [...text].length;

function roundReport(concluded: string): ClosingReport {
  return {
    schema: "closing-report/v1",
    concluded,
    question: "Should the round's own question reach the report?",
    suggested_next: { step: "Run another round.", owner: "line" },
    cause: "scope",
  };
}

function parked(
  ...items: { reason: string; decision?: ParkedDecision }[]
): DriveState {
  return {
    ...freshState(999),
    parked: items.map((item, i) => ({
      key: `PRRT_${i}`,
      kind: "thread" as const,
      round: 2,
      ...item,
    })),
  };
}

const decision = (question: string) =>
  JSON.parse(parkRecord(question)) as ParkedDecision;

describe("the closing report's concluded", () => {
  test("is the stop's text, then the last round's conclusion", () => {
    expect(
      composeConcluded("PR #1's drive stalled (exit 14)", "Fixed one thread."),
    ).toBe("PR #1's drive stalled (exit 14) Last round: Fixed one thread.");
  });

  test("cuts the round's conclusion to the room the stop leaves", () => {
    const stop = "s".repeat(400);
    const out = composeConcluded(stop, "r".repeat(400));
    expect(chars(out)).toBe(CONCLUDED_MAX);
    expect(out.startsWith(`${stop} Last round: r`)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  test("keeps the stop's text whole and leaves the round out when no room is left", () => {
    const stop = "s".repeat(CONCLUDED_MAX - 13);
    expect(composeConcluded(stop, "the round")).toBe(stop);
    expect(composeConcluded("s".repeat(CONCLUDED_MAX), "the round")).toBe(
      "s".repeat(CONCLUDED_MAX),
    );
  });

  test("cuts the stop's own text to the limit when it alone exceeds it", () => {
    const out = composeConcluded("s".repeat(CONCLUDED_MAX + 50), "the round");
    expect(chars(out)).toBe(CONCLUDED_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("Last round");
  });

  test("counts characters, not bytes", () => {
    const stop = "é".repeat(500);
    const out = composeConcluded(stop, "ü".repeat(500));
    expect(chars(out)).toBe(CONCLUDED_MAX);
    expect(cutTo("ab", 1)).toBe("…");
    expect(cutTo("ab", 2)).toBe("ab");
  });

  test("is the stop's text alone with no round report", () => {
    expect(composeConcluded("stopped", null)).toBe("stopped");
    expect(composeConcluded("stopped", "  ")).toBe("stopped");
  });
});

describe("the driver's closing report", () => {
  test("names the pages a check-runs listing read before it was cut short", () => {
    driverRuntime.stopListingPages = 14;
    try {
      const report = composeDriverReport({
        pr: "42",
        code: DRIVE_EXIT.CHECK_RUNS_UNREADABLE,
        state: null,
        round: null,
      });
      expect(checkClosingReport(report)).toEqual([]);
      expect(report.concluded).toContain("after 14 page(s)");
      expect(report.cause).toBe("tool-failed");
      expect(report.suggested_next?.owner).toBe("line");
    } finally {
      driverRuntime.stopListingPages = null;
    }
  });

  test("takes the cause and the next step from the registry's entry for the exit", () => {
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.CONVERGED,
      state: null,
      round: null,
    });
    expect(checkClosingReport(report)).toEqual([]);
    expect(report.concluded).toStartWith("PR #42's drive converged");
    expect(report.cause).toBeUndefined();
    expect(report.suggested_next).toEqual({
      step: "Merge the pull request once its required checks pass.",
      owner: "person",
      act: "Merge",
    });
    expect(report.evidence).toEqual(["pr:#42"]);

    const stalled = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.STALLED,
      state: null,
      round: roundReport(
        "Stood down: the reviewer's finding asks for a schema.",
      ),
    });
    expect(stalled.cause).toBe("unknown");
    expect(stalled.concluded).toBe(
      "PR #42's drive stalled: its passes changed nothing (exit 14) Last round: Stood down: the reviewer's finding asks for a schema.",
    );
  });

  test("never takes a question, a decision or a cause from a round report", () => {
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.MAX_ROUNDS,
      state: parked({ reason: "Which release?" }),
      round: roundReport("Answered two threads."),
    });
    expect(report.question).toBeUndefined();
    expect(report.decision).toBeUndefined();
    expect(report.cause).toBe("deadline");
  });

  test("names an exit the registry does not hold as unknown, for a person to investigate", () => {
    const report = composeDriverReport({
      pr: "42",
      code: 77,
      state: null,
      round: null,
    });
    expect(checkClosingReport(report)).toEqual([]);
    expect(report.cause).toBe("unknown");
    expect(report.suggested_next.owner).toBe("person");
    expect(report.suggested_next.act).toBe("Investigate");
    expect(report.concluded).toContain("exit 77");
  });

  test("at a park, copies the first parked item's question and framed decision, naming how many more wait", () => {
    const first = decision("Keep the old field name?");
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.HITL_PARKED,
      state: parked(
        { reason: "Keep the old field name?", decision: first },
        {
          reason: "Split the module?",
          decision: decision("Split the module?"),
        },
        { reason: "Rename the flag?" },
      ),
      round: null,
    });
    expect(checkClosingReport(report)).toEqual([]);
    expect(report.question).toBe("Keep the old field name?");
    expect(report.decision).toEqual(first);
    expect(report.cause).toBe("needs-person");
    expect(report.suggested_next.act).toBe("Decide");
    expect(report.concluded).toBe(
      "PR #42 parked: Keep the old field name? (and 2 more decisions)",
    );
  });

  test("at a park, retains the status probe before a long parked-decision summary", () => {
    driverRuntime.stopProbe = {
      code: DRIVE_EXIT.HITL_PARKED,
      state: "HITL_PARKED",
      reason: "the public API choice needs a person",
    };
    try {
      const report = composeDriverReport({
        pr: "42",
        code: DRIVE_EXIT.HITL_PARKED,
        state: parked({ reason: "x".repeat(3000) }),
        round: null,
      });
      expect(checkClosingReport(report)).toEqual([]);
      expect(report.concluded).toContain("HITL_PARKED");
      expect(report.concluded).toContain(
        "the public API choice needs a person",
      );
    } finally {
      driverRuntime.stopProbe = null;
    }
  });

  test("at a park without a framed decision, asks the parked item's reason as a question", () => {
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.HITL_PARKED,
      state: parked({ reason: "The finding asks for a new public API." }),
      round: null,
    });
    expect(checkClosingReport(report)).toEqual([]);
    expect(report.decision).toBeUndefined();
    expect(report.question).toBe(
      "What is the decision on thread PRRT_0: The finding asks for a new public API?",
    );
  });

  test("a park whose question is too long still passes the check, its question cut", () => {
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.HITL_PARKED,
      state: parked({ reason: "x".repeat(3000) }),
      round: roundReport("y".repeat(700)),
    });
    expect(checkClosingReport(report)).toEqual([]);
    expect(chars(report.concluded)).toBe(CONCLUDED_MAX);
    expect(report.question?.endsWith("?")).toBe(true);
    expect(chars(report.question ?? "")).toBeLessThanOrEqual(1000);
  });

  test("a stop that parks nothing writes neither a question nor a decision", () => {
    for (const code of [
      DRIVE_EXIT.CONVERGED,
      DRIVE_EXIT.STALLED,
      DRIVE_EXIT.QUOTA_PARKED,
    ]) {
      const report = composeDriverReport({
        pr: "42",
        code,
        state: parked({
          reason: "Which release?",
          decision: decision("Which release?"),
        }),
        round: null,
      });
      expect(report.question).toBeUndefined();
      expect(report.decision).toBeUndefined();
    }
  });

  test("redacts what the stop and the round name before measuring them", () => {
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.STALLED,
      state: null,
      round: roundReport(`Asked someone@example.com; ${"z".repeat(560)}`),
    });
    expect(checkClosingReport(report)).toEqual([]);
    expect(report.concluded).not.toContain("someone@example.com");
    expect(report.concluded).toContain("<redacted>");
    expect(chars(report.concluded)).toBeLessThanOrEqual(CONCLUDED_MAX);
  });

  test("writes nothing for a drive no wrapper named a report file for", async () => {
    // No `JIG_DRIVER_REPORT`: the function returns before it reads anything.
    await writeClosingReport("42", 0, "", {
      JIG_LAUNCH: "drive-pr 42 driver 1",
    });
    await writeClosingReport("42", 0, "", {
      JIG_DRIVER_REPORT: "/nonexistent/x",
    });
  });
});
