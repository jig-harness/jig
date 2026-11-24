import { expect, spyOn, test } from "bun:test";
import {
  inProcessProbeOf,
  probeStopOf,
  recordProbeStop,
} from "../scripts/lib/status/probe-stop.ts";

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

test("a park stop keeps every valid parked key, however long or many", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const keys = [
      "k".repeat(300),
      ...Array.from({ length: 80 }, (_, i) => `park-${i}`),
    ];
    const probe = recordProbeStop(8, {
      state: "HITL_PARKED",
      reason: "decisions wait",
      work: { actionableParkKeys: keys },
    });
    expect(probe?.parkKeys).toEqual(keys);
    const printed = String(log.mock.calls.at(-1)?.[0]);
    expect(printed.length).toBeLessThan(1024);
    expect(printed).not.toContain("parkKeys");
  } finally {
    log.mockRestore();
  }
});

test("the durable probe form drops the park keys that the in-process probe keeps", () => {
  const raw = {
    code: 8,
    state: "HITL_PARKED",
    reason: "decisions wait",
    parkKeys: ["k".repeat(300), "park-1"],
  };
  expect(inProcessProbeOf(raw)?.parkKeys).toEqual(raw.parkKeys);
  const durable = probeStopOf(raw);
  expect(durable).toEqual({
    code: 8,
    state: "HITL_PARKED",
    reason: "decisions wait",
  });
  expect(JSON.stringify(durable)).not.toContain("parkKeys");
});
