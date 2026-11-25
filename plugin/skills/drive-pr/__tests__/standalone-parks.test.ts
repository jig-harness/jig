/**
 * Which parks hold the status gate at HITL_PARKED when no live thread or
 * summary finding names them, and the round step's re-read after the
 * cancelled-CI recovery clears the park the gate stopped on. The status
 * gate's own fixture tests are in drive-pr-status-parking.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { recoverBeforePass } from "../scripts/lib/driver/round-step.ts";
import { unlistedParkDetails } from "../scripts/lib/provisional.ts";

const rep = (
  openThreadKeys: string[] = [],
  summaryUnaddressedKeys: string[] = [],
) => ({
  openThreadKeys,
  summaryUnaddressedKeys,
  actionableParkKeys: null,
});

const sets = (keys: string[], reversals: string[] = []) => ({
  keys: new Set(keys),
  reversals: new Set(reversals),
});

describe("unlistedParkDetails", () => {
  it("counts a standalone finding park that no thread or finding lists", () => {
    expect(unlistedParkDetails(sets(["ratchet-rule"]), rep())).toEqual({
      reversalParked: 0,
      standaloneParked: 1,
      standaloneNote: ", 1 standalone park(s)",
    });
  });

  it("leaves out a park the live threads and summary findings already list", () => {
    expect(
      unlistedParkDetails(
        sets(["PRRT_live", "fp-live"]),
        rep(["PRRT_live"], ["fp-live"]),
      ),
    ).toEqual({ reversalParked: 0, standaloneParked: 0, standaloneNote: "" });
  });

  it("counts the park of a thread that is no longer open", () => {
    expect(unlistedParkDetails(sets(["PRRT_resolved"]), rep())).toEqual({
      reversalParked: 0,
      standaloneParked: 1,
      standaloneNote: ", 1 standalone park(s)",
    });
  });

  it("counts a reversed provisional decision, even on a resolved thread", () => {
    expect(
      unlistedParkDetails(sets(["PRRT_reopened"], ["PRRT_reopened"]), rep()),
    ).toEqual({ reversalParked: 1, standaloneParked: 0, standaloneNote: "" });
  });
});

describe("recoverBeforePass after a gate parked on cancelled CI alone", () => {
  const status = (parkedKeys: string[]) => ({
    head: { api: "a".repeat(40) },
    work: { parkedKeys },
  });
  const pass = (
    parkedKeys: string[],
    cleared: boolean,
    recovery: "none" | "wait" = "none",
  ) =>
    recoverBeforePass(
      { pr: "5", dryRun: false },
      8,
      status(parkedKeys),
      async () => recovery,
      async () => cleared,
    );

  it("reads the gate again once the recovery cleared the park", async () => {
    expect(await pass(["cancelled-ci"], true)).toBe("continue");
  });

  it("hands the park back when the recovery left it in place", async () => {
    expect(await pass(["cancelled-ci"], false)).toBeNull();
  });

  it("reads the gate again when the cleared park was one of several", async () => {
    expect(await pass(["cancelled-ci", "ratchet-rule"], true)).toBe("continue");
    expect(await pass(["ratchet-rule"], true)).toBeNull();
  });
});
