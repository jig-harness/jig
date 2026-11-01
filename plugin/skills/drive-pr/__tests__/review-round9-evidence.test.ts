import { describe, expect, it } from "bun:test";
import { oneLine } from "../scripts/lib/morning-report.ts";
import { snapshotFrom } from "../scripts/lib/state/ledger.ts";
import { ledgerRecord } from "../scripts/loop-metrics.ts";

describe("oneLine — comment delimiters never survive", () => {
  it.each([
    ["a <!-- x --!> b", "a b"],
    ["a <!<!---->--> b", "a <! b"],
    ["a --!> b", "a b"],
    ["a <!-- unclosed", "a unclosed"],
  ])("%j", (input, want) => {
    const out = oneLine(input, 200);
    expect(out).toBe(want);
    expect(out).not.toContain("<!--");
  });
});

describe("ledgerRecord — a damaged ledger is not an absent one", () => {
  it("reads unread when only a malformed ledger comment exists", () => {
    const snapshot = snapshotFrom(
      [
        {
          id: 1,
          login: "me",
          association: "OWNER",
          body: "<!-- drive-pr-ledger -->\nnot a ledger",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      "me",
    );
    expect(ledgerRecord(snapshot)).toEqual({ ledger: null, unread: true });
  });

  it("reads absent when no ledger comment exists", () => {
    expect(ledgerRecord(snapshotFrom([], "me"))).toEqual({
      ledger: null,
      unread: false,
    });
  });
});
