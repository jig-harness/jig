/**
 * drive-pr suite: the round finishes `finish-round.ts` records for the stall
 * stop (`lib/state/round-finish.ts`), and what a stall makes of them.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import {
  finishCause,
  finishSince,
  readRoundFinishes,
  recordRoundFinish,
  type RoundFinish,
  sharedFinish,
} from "../scripts/lib/state/round-finish.ts";
import { tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";

useDrivePrSuite();

const finish = (state: string, at: string, reason = `${state} reason`) =>
  ({ round: 1, state, reason, head: "a".repeat(40), at }) as RoundFinish;

describe("round finishes", () => {
  it("keeps the newest few, oldest first, and finds the one a pass recorded", () => {
    const dir = mkdtempSync(join(tmpRoot, "round-finish-"));
    for (let i = 0; i < 20; i++)
      recordRoundFinish(
        dir,
        "7",
        finish(
          "CI_HOLD_WAIT",
          `2026-11-19T10:${String(i).padStart(2, "0")}:00.000Z`,
        ),
      );
    const kept = readRoundFinishes(dir, "7");
    expect(kept).toHaveLength(16);
    expect(kept[0]?.at).toBe("2026-11-19T10:04:00.000Z");
    expect(finishSince(kept, "2026-11-19T10:18:30.000Z")?.at).toBe(
      "2026-11-19T10:19:00.000Z",
    );
    expect(finishSince(kept, "2026-11-19T11:00:00.000Z")).toBeNull();
    expect(readRoundFinishes(dir, "8")).toEqual([]);
  });

  it("names the state every stalled pass ended on, with the last reason", () => {
    const at = "2026-11-19T10:00:00.000Z";
    expect(
      sharedFinish([
        finish("CI_HOLD_WAIT", at, "first"),
        finish("CI_HOLD_WAIT", at, "second"),
      ]),
    ).toEqual({ state: "CI_HOLD_WAIT", reason: "second" });
  });

  it("names nothing when the passes differ, one recorded none, or they all finished", () => {
    const at = "2026-11-19T10:00:00.000Z";
    expect(
      sharedFinish([finish("CI_HOLD_WAIT", at), finish("PUSH_FAILED", at)]),
    ).toBeNull();
    expect(sharedFinish([finish("CI_HOLD_WAIT", at), null])).toBeNull();
    expect(
      sharedFinish([finish("FINISHED", at), finish("FINISHED", at)]),
    ).toBeNull();
    expect(sharedFinish([])).toBeNull();
  });

  it("gives a stall held by a known state its cause, any other unknown", () => {
    expect(finishCause("CI_HOLD_WAIT")).toBe("environment");
    expect(finishCause("REFUSED_UNCLEAN")).toBe("refused");
    expect(finishCause("PUSH_FAILED")).toBe("tool-failed");
    expect(finishCause("SOMETHING_NEW")).toBe("unknown");
  });
});
