/**
 * What the steward's records reader (`checkedRecords` in `lib/steward.ts`)
 * accepts and refuses, with the reason each refusal gives. It reads a pass's
 * submission (`skills/steward/scripts/steward.ts submit`) and each kept
 * record the tick applies (`stewardRecords`), against the shape descriptions
 * the Protocol's schemas are generated from (`lib/steward-record-shapes.ts`).
 * These cases pin every form a record may take and each way a field can
 * break, with the reason each refusal gives. Before the reader read through
 * the descriptions it accepted a facet named by a list (`["type"]`), which
 * the tick could never apply; it now refuses one, and reads every other
 * record as it did.
 */
import { describe, expect, test } from "bun:test";
import { checkedRecords } from "../lib/steward.ts";

const ARRAY = "the steward submits at most 100 records as a JSON array";
const REASON = "each steward record needs a reason";
const FIELDS = "the steward record kind or fields are not allowed";
const VALUES = "a steward record has invalid values";

/** `reads`, or the reason the submission is refused. */
function verdict(submission: unknown): string {
  const checked = checkedRecords(submission);
  return checked.ok ? "reads" : checked.failure.reason;
}

const one = (record: unknown) => verdict([record]);

/** A character outside the Basic Multilingual Plane: one code point, two UTF-16 code units. */
const ASTRAL = "\u{1F600}";

const REARM = {
  kind: "rearm",
  target: "PR #12",
  facts: "recovery: generation 3, exit 16, heartbeat 2026-11-01T00:00:00Z",
  class: "network timeout",
  reason: "the log shows a transient network failure",
};
const RESUME = {
  kind: "resume",
  record: "20261101T000000Z-0123abcd",
  reason: "the pass recommended one option",
};
const NEED = {
  kind: "need",
  target: "PR #12",
  act: "Decide",
  ask: "Choose whether to keep the old endpoint.",
  reason: "the question is the repository's",
};
const PRIORITY = {
  kind: "facet",
  target: "#34",
  facet: "priority",
  value: 2,
  reason: "it blocks the release",
};
const TYPE = {
  kind: "facet",
  target: "#34",
  facet: "type",
  value: "feature",
  reason: "it adds a command",
};
const ORDER = {
  kind: "order",
  targets: ["#34", "#35"],
  reason: "the smaller one unblocks the other",
};
const CAUSE = {
  kind: "cause",
  record: "20261101T000000Z-0123abcd",
  cause: "tool-failed",
  summary: "Wrote the migration, then the test runner failed to start.",
  reason: "the excerpt ends on the runner's error",
};

describe("the steward records reader accepts", () => {
  test("each kind in its every form", () => {
    for (const record of [
      REARM,
      RESUME,
      NEED,
      PRIORITY,
      TYPE,
      { ...TYPE, facet: "size", value: "S" },
      ORDER,
      CAUSE,
    ])
      expect(one(record)).toBe("reads");
  });

  test("an empty submission, and one of a hundred records", () => {
    expect(verdict([])).toBe("reads");
    expect(verdict(Array.from({ length: 100 }, () => REARM))).toBe("reads");
  });

  test("every value of each closed field", () => {
    for (const act of [
      "Merge",
      "Decide",
      "Authorize",
      "Reply",
      "Do",
      "Investigate",
    ])
      expect(one({ ...NEED, act })).toBe("reads");
    for (const cause of [
      "needs-person",
      "refused",
      "tool-failed",
      "environment",
      "scope",
      "crashed",
      "unknown",
    ])
      expect(one({ ...CAUSE, cause })).toBe("reads");
    for (const value of [1, 2, 3, 4])
      expect(one({ ...PRIORITY, value })).toBe("reads");
  });

  test("each string at its bound", () => {
    expect(one({ ...REARM, reason: "r".repeat(4000) })).toBe("reads");
    expect(one({ ...REARM, facts: ` ${"f".repeat(3998)} ` })).toBe("reads");
    expect(one({ ...REARM, target: `PR #${"9".repeat(3996)}` })).toBe("reads");
    expect(one({ ...TYPE, value: "v".repeat(100) })).toBe("reads");
    expect(one({ ...CAUSE, summary: "s".repeat(600) })).toBe("reads");
    // The summary is counted in characters, the other strings in UTF-16 code units.
    expect(one({ ...CAUSE, summary: ASTRAL.repeat(600) })).toBe("reads");
    expect(one({ ...REARM, reason: ASTRAL.repeat(2000) })).toBe("reads");
    expect(one({ ...TYPE, value: ASTRAL.repeat(50) })).toBe("reads");
  });

  test("an order of no targets, and of a hundred", () => {
    expect(one({ ...ORDER, targets: [] })).toBe("reads");
    expect(
      one({
        ...ORDER,
        targets: Array.from({ length: 100 }, (_, i) => `#${i + 1}`),
      }),
    ).toBe("reads");
  });
});

describe("the steward records reader refuses", () => {
  test("a submission that is not a list of at most a hundred records", () => {
    expect(verdict({})).toBe(ARRAY);
    expect(verdict(null)).toBe(ARRAY);
    expect(verdict("[]")).toBe(ARRAY);
    expect(verdict(Array.from({ length: 101 }, () => REARM))).toBe(ARRAY);
  });

  test("a record with no reason, before anything else about it", () => {
    for (const record of [
      null,
      "rearm",
      [],
      { ...REARM, reason: undefined },
      { ...REARM, reason: "" },
      { ...REARM, reason: " \n\t" },
      { ...REARM, reason: 7 },
      { ...REARM, reason: "r".repeat(4001) },
      { ...REARM, reason: ASTRAL.repeat(2001) },
      { kind: "constructor" },
    ])
      expect(one(record)).toBe(REASON);
  });

  test("a kind it does not know, or a field its kind does not have", () => {
    for (const record of [
      { kind: "constructor", reason: "invalid kind" },
      { kind: "send", text: "continue", reason: "free text" },
      { kind: "settle", target: "#34", reason: "not in the remit" },
      { reason: "no kind" },
      { ...REARM, model: "a model" },
      { ...RESUME, target: "PR #12" },
      { ...ORDER, target: "#34" },
      { ...CAUSE, tier: "complex" },
    ])
      expect(one(record)).toBe(FIELDS);
  });

  test("a kind named by a value other than its name", () => {
    expect(one({ ...REARM, kind: ["rearm"] })).toBe(VALUES);
  });

  test("a missing field, or a field without its kind's value", () => {
    const { facts: _facts, ...noFacts } = REARM;
    const { targets: _targets, ...noTargets } = ORDER;
    const { value: _value, ...noValue } = PRIORITY;
    for (const record of [
      noFacts,
      noTargets,
      noValue,
      { ...REARM, target: "PR #0" },
      { ...REARM, target: "PR #012" },
      { ...REARM, target: "#12" },
      { ...REARM, target: "PR #12 " },
      { ...REARM, target: "PR #12\n" },
      { ...REARM, target: `PR #${"9".repeat(3997)}` },
      { ...REARM, class: "" },
      { ...REARM, facts: "f".repeat(4001) },
      { ...RESUME, record: "" },
      { ...RESUME, record: 12 },
      { ...NEED, act: "Approve" },
      { ...NEED, act: "decide" },
      { ...NEED, ask: "   " },
      { ...PRIORITY, value: 0 },
      { ...PRIORITY, value: 5 },
      { ...PRIORITY, value: 2.5 },
      { ...PRIORITY, value: "2" },
      { ...PRIORITY, value: null },
      { ...TYPE, value: "" },
      { ...TYPE, value: 3 },
      { ...TYPE, value: "v".repeat(101) },
      { ...TYPE, value: ASTRAL.repeat(51) },
      { ...TYPE, facet: "estimate" },
      { ...TYPE, facet: "Priority" },
      { ...ORDER, targets: "#34" },
      { ...ORDER, targets: ["#34", "#34"] },
      { ...ORDER, targets: ["#34", ""] },
      { ...ORDER, targets: ["#34", 35] },
      {
        ...ORDER,
        targets: Array.from({ length: 101 }, (_, i) => `#${i + 1}`),
      },
      { ...CAUSE, cause: "deadline" },
      { ...CAUSE, cause: "startup" },
      { ...CAUSE, cause: "usage-limit" },
      { ...CAUSE, summary: "s".repeat(601) },
      { ...CAUSE, summary: ASTRAL.repeat(601) },
      { ...CAUSE, summary: " " },
    ])
      expect(one(record)).toBe(VALUES);
  });

  test("a facet named by a list rather than its name", () => {
    expect(one({ ...TYPE, facet: ["type"] })).toBe(VALUES);
    expect(one({ ...TYPE, facet: ["size"] })).toBe(VALUES);
  });

  test("a whole submission for one record it refuses", () => {
    expect(verdict([REARM, { ...NEED, act: "Approve" }, ORDER])).toBe(VALUES);
    expect(verdict([REARM, { ...ORDER, reason: "" }])).toBe(REASON);
  });
});
