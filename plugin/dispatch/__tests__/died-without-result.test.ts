import { expect, it } from "bun:test";
import type { ReadRecord } from "../lib/launches.ts";
import { diedWithoutResult } from "../lib/session-startup.ts";

/** A follow-up that ended on a failing exit with no result, optionally with a closing report. */
function ended(question?: string): ReadRecord {
  return {
    record: { action: "followup" },
    result: null,
    state: {
      kind: "ended",
      exit: { code: 1, signal: null, at: "2026-11-15T00:00:00.000Z" },
    },
    report:
      question === undefined
        ? null
        : { at: "2026-11-15T00:00:00.000Z", report: { question } },
  } as unknown as ReadRecord;
}

it("a failing exit with no result and no question died", () => {
  expect(diedWithoutResult(ended())).toBe(true);
});

it("a failing exit whose closing report asks a question did not die", () => {
  expect(diedWithoutResult(ended("Which base?"))).toBe(false);
});
