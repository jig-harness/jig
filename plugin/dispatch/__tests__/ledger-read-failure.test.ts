/** The read that failed beside an unplaced ledger: an absence never outranks another read's failure. */
import { describe, expect, it } from "bun:test";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { failedRead } from "../lib/sources/ledger-read-failure.ts";

const ledger = { driver: { exit: DRIVE_EXIT.HITL_PARKED } } as never;
const park = {
  unreadable: "thread t",
  failure: { class: "not-found", absence: true },
} as never;

describe("failedRead", () => {
  it("keeps a park's absence marked when nothing else failed", () => {
    const forge = { head: "a", mergeable: "MERGEABLE" } as never;
    expect(failedRead(ledger, park, forge).failure).toEqual({
      class: "not-found",
      absence: true,
    });
  });

  it("lets a base head that failed beside an absence decide the class", () => {
    const forge = {
      head: "a",
      mergeable: "MERGEABLE",
      base: { unreadable: "rate limited", failure: { class: "rate-limited" } },
    } as never;
    const got = failedRead(ledger, park, forge);
    expect(got.failure?.class).toBe("rate-limited");
    expect(got.failure?.absence).toBeUndefined();
  });
});
