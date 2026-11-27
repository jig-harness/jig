/**
 * How a stall's passes finished (`state/events.ts`'s `StallReasons`): the
 * last reasons they recorded and how many recorded none, as the stall's stop
 * event keeps them and the ledger's summary names them.
 */
import { describe, expect, it } from "bun:test";

import {
  type DriveEvent,
  STALL_REASON_MAX,
  isDriveEvent,
  redactedFinish,
  stallReasonsLine,
  stallReasonsOf,
  stopReasons,
  stopReasonsSummary,
  withOlderFinishesCut,
} from "../scripts/lib/state/events.ts";

const finish = (round: number, state: string, reason: string) => ({
  round,
  state,
  reason,
});
const stop = (cause: string, reasons?: unknown): DriveEvent => ({
  at: "2026-11-27T10:00:00.000Z",
  round: 3,
  kind: "stop",
  cause,
  ...(reasons === undefined ? {} : { reasons }),
});

describe("stallReasonsOf", () => {
  it("keeps the last reasons recorded and counts the passes that recorded none", () => {
    const reasons = stallReasonsOf([
      finish(1, "CI_HOLD_WAIT", "first"),
      null,
      finish(3, "HEAD_NOT_SYNCED", "second\n  on two lines"),
      finish(4, "LEASE_HELD", "third"),
      finish(5, "FINISHED", "fourth"),
    ]);
    expect(reasons).toEqual({
      last: [
        finish(3, "HEAD_NOT_SYNCED", "second on two lines"),
        finish(4, "LEASE_HELD", "third"),
        finish(5, "FINISHED", "fourth"),
      ],
      missing: 1,
      passes: 5,
    });
  });

  it("counts every pass as missing when none recorded a reason", () => {
    const reasons = stallReasonsOf([null, null]);
    expect(reasons).toEqual({ last: [], missing: 2, passes: 2 });
    expect(stallReasonsLine(reasons as NonNullable<typeof reasons>)).toBe(
      "no pass recorded a reason (2 of 2 passes recorded no reason)",
    );
  });

  it("names nothing for a stall with no passes", () => {
    expect(stallReasonsOf([])).toBeUndefined();
  });

  it("cuts a long reason to the kept length", () => {
    const reasons = stallReasonsOf([finish(1, "PARTIAL", "x".repeat(900))]);
    expect(reasons?.last[0]?.reason).toHaveLength(STALL_REASON_MAX);
  });
});

describe("stallReasonsLine", () => {
  it("names each kept reason and the passes that recorded none", () => {
    expect(
      stallReasonsLine({
        last: [finish(2, "CI_HOLD_WAIT", "the hold is not ready")],
        missing: 1,
        passes: 2,
      }),
    ).toBe(
      "round 2 CI_HOLD_WAIT: the hold is not ready; 1 of 2 passes recorded no reason",
    );
    expect(
      stallReasonsLine({
        last: [finish(2, "CI_HOLD_WAIT", "the hold is not ready")],
        missing: 0,
        passes: 1,
      }),
    ).toBe(
      "round 2 CI_HOLD_WAIT: the hold is not ready; every pass recorded a reason",
    );
  });
});

describe("a stall's stop event", () => {
  const reasons = {
    last: [finish(2, "LEASE_HELD", "x")],
    missing: 1,
    passes: 2,
  };

  it("carries the tally on a stop only", () => {
    expect(isDriveEvent(stop("14", reasons))).toBe(true);
    expect(
      isDriveEvent({ ...stop("14", reasons), kind: "restart", cause: "stall" }),
    ).toBe(false);
  });

  it("reads the tally of the stop with the exit asked for, and only a well-formed one", () => {
    expect(stopReasons([stop("14", reasons)], 14)).toEqual(reasons);
    expect(stopReasons([stop("14", reasons)], 1)).toBeNull();
    expect(stopReasons([stop("14", reasons), stop("1")], 14)).toBeNull();
    expect(stopReasons([stop("14", { ...reasons, passes: 0 })], 14)).toBeNull();
    expect(
      stopReasons(
        [stop("14", { ...reasons, last: [finish(2, "lower", "x")] })],
        14,
      ),
    ).toBeNull();
  });

  it("names the tally in the ledger's summary, keeping a mention from reaching anyone", () => {
    const summary = stopReasonsSummary(
      [
        stop("14", {
          ...reasons,
          last: [finish(2, "LEASE_HELD", "ask @someone")],
        }),
      ],
      { state: "stopped", exit: 14 },
    );
    expect(summary).toBe(
      "How the stalled passes finished: round 2 LEASE_HELD: ask @​someone; 1 of 2 passes recorded no reason",
    );
    expect(
      stopReasonsSummary([stop("14", reasons)], { state: "running", exit: 14 }),
    ).toBeNull();
  });

  it("drops a malformed tally when the ledger is written", () => {
    expect(redactedFinish(stop("14", { last: "x" })).reasons).toBeUndefined();
    expect(redactedFinish(stop("14", reasons)).reasons).toEqual(reasons);
  });

  it("keeps only the newest stop's tally once older finish details are cut", () => {
    const cut = withOlderFinishesCut({
      events: [stop("14", reasons), stop("14", reasons)],
      cut: [] as string[],
    });
    expect(cut.events.map((e) => e.reasons === undefined)).toEqual([
      true,
      false,
    ]);
  });
});

describe("a stall's stop line", () => {
  it("redacts a reason before cutting it, so a cut cannot split an address the redactor matches", async () => {
    const { stopText } = await import("../scripts/lib/driver/stop-text.ts");
    const { driverRuntime } = await import("../scripts/lib/driver/runtime.ts");
    const email = "someone.with.a.long.name@example-domain.org";
    const reason = `${"x".repeat(77)} ${email}`;
    driverRuntime.stallReasons = stallReasonsOf([
      finish(1, "PARTIAL", reason),
    ]) as NonNullable<typeof driverRuntime.stallReasons>;
    try {
      const line = stopText("7", 14, null, null) ?? "";
      expect(line).not.toContain("@example");
      expect(line).not.toContain("someone.with");
      expect(line).not.toContain("example-domain.o");
    } finally {
      driverRuntime.stallReasons = null;
    }
  });
});
