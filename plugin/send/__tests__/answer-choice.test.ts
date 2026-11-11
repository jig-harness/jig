/**
 * A structured answer checked against its park before `jig send` writes
 * it: a park with no framing, and one whose decision record does not read,
 * are refused with what is wrong with each; and a choice the readers'
 * parser would not read back as that option is refused rather than written.
 */
import { describe, expect, it } from "bun:test";
import { resolveChoice } from "../lib/answer-choice.ts";
import { legacyParkRecord } from "../../skills/drive-pr/__tests__/park-record-fixture.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import { framedPark } from "./send-fixtures.ts";

const base: ParkedItem = {
  key: "F_k",
  kind: "finding",
  reason: "Keep it?",
  round: 1,
  at: "2026-11-01T09:00:00.000Z",
};

const reason = (r: ReturnType<typeof resolveChoice>) =>
  r.ok ? "" : r.failure.reason;

describe("resolveChoice", () => {
  it("refuses a park with no framing, saying it offers no option", () => {
    const r = resolveChoice(base, { kind: "approve" }, undefined, "maintainer");
    expect(reason(r)).toContain("no framed decision");
  });

  it("refuses a park whose decision record does not read, naming what is wrong with it", () => {
    const item = {
      ...base,
      class: "escalated",
      record: "## Question\n\nKeep it?",
    };
    const r = resolveChoice(
      item,
      { kind: "choose", option: "Keep it" },
      undefined,
      "maintainer",
    );
    expect(reason(r)).toContain("decision record does not read");
    expect(reason(r)).toContain("Options");
  });

  it("chooses an option of a legacy record that reads", () => {
    const item = {
      ...base,
      class: "escalated",
      record: legacyParkRecord("Keep it"),
    };
    const r = resolveChoice(
      item,
      { kind: "choose", option: "change it" },
      undefined,
      "maintainer",
    );
    expect(r.ok && r.value.text).toBe("choose Change it");
  });

  it("refuses a choice the readers would not read back as that option", () => {
    const item = framedPark("F_k", "scope");
    const option = item.decision?.call.options[1];
    if (option === undefined) throw new Error("fixture has two options");
    option.name = "Notify <redacted>";
    delete item.digest;
    const r = resolveChoice(
      item,
      { kind: "choose", option: "Notify <redacted>" },
      undefined,
      "maintainer",
    );
    expect(reason(r)).toContain(
      "would not read this answer as choosing Notify <redacted>",
    );
  });
});
