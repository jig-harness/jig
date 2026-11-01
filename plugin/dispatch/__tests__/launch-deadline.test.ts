import { describe, expect, it } from "bun:test";
import { type ApplyState, outOfTime, rotated } from "../lib/actions/launch.ts";
import type { MachineConfig } from "../lib/machine-config.ts";

const machine = {
  intervalMs: 5 * 60_000,
  runtimeTimeoutMs: 1_000,
  workspaceTimeoutMs: 1_000,
} as MachineConfig;

function stateAt(startedAt: number | undefined): ApplyState {
  return { machine, startedAt } as ApplyState;
}

describe("a tick's targets and deadline", () => {
  it("starts at a different target each tick, for any number of targets", () => {
    const items = ["a", "b", "c", "d", "e"];
    const firsts = [0, 1, 2, 3, 4].map(
      (n) => rotated(stateAt(n * machine.intervalMs), items)[0],
    );
    expect(firsts).toEqual(items);
  });

  it("keeps the order when the tick has no start", () => {
    expect(rotated(stateAt(undefined), ["a", "b"])).toEqual(["a", "b"]);
  });

  it("has no time left once the budget has passed", () => {
    expect(outOfTime(stateAt(Date.now()))).toBeNull();
    expect(outOfTime(stateAt(Date.now() - 3_600_000))).toContain(
      "timer allows",
    );
  });
});
