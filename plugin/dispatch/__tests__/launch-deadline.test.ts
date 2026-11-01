import { describe, expect, it } from "bun:test";
import {
  type ApplyState,
  enforcedDeadlineMs,
  outOfTime,
  rotated,
} from "../lib/actions/launch.ts";
import type { MachineConfig } from "../lib/machine-config.ts";

const machine = {
  intervalMs: 5 * 60_000,
  runtimeTimeoutMs: 1_000,
  workspaceTimeoutMs: 1_000,
} as MachineConfig;

function stateAt(startedAt: number | undefined): ApplyState {
  return { machine, startedAt } as ApplyState;
}

function stateOnTick(tick: number | undefined): ApplyState {
  return { machine, tick } as ApplyState;
}

describe("a tick's targets and deadline", () => {
  it("starts at a different target each tick, for any number of targets", () => {
    const items = ["a", "b", "c", "d", "e"];
    const firsts = [0, 1, 2, 3, 4].map(
      (n) => rotated(stateOnTick(n), items)[0],
    );
    expect(firsts).toEqual(items);
  });

  it("advances by one target a tick however far apart the ticks start", () => {
    const items = ["a", "b", "c"];
    expect(rotated(stateOnTick(1), items)[0]).toBe("b");
    expect(rotated(stateOnTick(2), items)[0]).toBe("c");
  });

  it("keeps the order when the tick has no index", () => {
    expect(rotated(stateOnTick(undefined), ["a", "b"])).toEqual(["a", "b"]);
  });

  it("has no time left once the installed deadline has passed", () => {
    expect(outOfTime(stateAt(Date.now()))).toBeNull();
    expect(outOfTime(stateAt(Date.now() - 7 * 3_600_000))).toContain(
      "timer allows",
    );
  });

  it("counts a slow planning phase against the launcher's deadline, not the launches' budget", () => {
    // More than the 3s the launches' budget covers here, well within the six hours the launcher allows.
    expect(outOfTime(stateAt(Date.now() - 600_000))).toBeNull();
  });

  it("turns each level once per turn of the levels above it", () => {
    const state = (tick: number) => ({ machine, tick, repos: 2 }) as ApplyState;
    // Two repositories: the first leads on even ticks and must still lead with each stage in turn.
    const stageLeads = [0, 2, 4, 6].map(
      (n) => rotated(state(n), ["rearm", "pickup", "followup"], "stages")[0],
    );
    expect(stageLeads).toEqual(["rearm", "pickup", "followup", "rearm"]);
    const targetLeads = [0, 6, 12, 18].map(
      (n) => rotated(state(n), ["a", "b"], "targets")[0],
    );
    expect(targetLeads).toEqual(["a", "b", "a", "b"]);
  });

  it("reserves time against the deadline the launcher was installed with", () => {
    const calculated = enforcedDeadlineMs(machine, {});
    expect(calculated).toBe(6 * 3_600_000);
    expect(
      enforcedDeadlineMs(machine, { JIG_LAUNCHER_DEADLINE_SEC: "7200" }),
    ).toBe(7_200_000);
    expect(
      enforcedDeadlineMs(machine, { JIG_LAUNCHER_DEADLINE_SEC: "x" }),
    ).toBe(calculated);
  });
});
