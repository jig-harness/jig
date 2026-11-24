import { expect, spyOn, test } from "bun:test";
import { recordProbeStop } from "../scripts/lib/status/probe-stop.ts";

test("a park stop carries the actionable keys the status JSON publishes under work", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const probe = recordProbeStop(8, {
      state: "HITL_PARKED",
      reason: "decisions wait",
      work: {
        actionableParkKeys: ["standalone-1"],
        parkedKeys: ["old", "standalone-1"],
      },
    });
    expect(probe?.parkKeys).toEqual(["standalone-1"]);
    const top = recordProbeStop(8, {
      state: "HITL_PARKED",
      reason: "decisions wait",
      actionableParkKeys: ["ignored"],
    });
    expect(top?.parkKeys).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});
