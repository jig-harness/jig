/**
 * The launch a session the line started carries: none outside one, the
 * dispatcher's launch record inside a dispatched one, and for a drive's pass
 * that inherited none, the driver itself; and apart from it, the dispatched
 * launch a drive was armed from.
 */
import { describe, expect, it } from "bun:test";
import {
  dispatchedFrom,
  launchOf,
  passLaunch,
  passLaunchEnv,
} from "../launched-session.ts";

const LAUNCH = "20261106T080000Z-abcdef12";

describe("launchOf", () => {
  it("reads the launch, and no launch from an unset or empty variable", () => {
    expect(launchOf({})).toBeNull();
    expect(launchOf({ JIG_LAUNCH: "  " })).toBeNull();
    expect(launchOf({ JIG_LAUNCH: "20261106T080000Z-abcdef12" })).toBe(
      "20261106T080000Z-abcdef12",
    );
  });
});

describe("passLaunch", () => {
  it("keeps the launch a dispatched driver inherited, and names the driver otherwise", () => {
    expect(
      passLaunch({ JIG_LAUNCH: "20261106T080000Z-abcdef12" }, "12", 3),
    ).toBe("20261106T080000Z-abcdef12");
    expect(passLaunch({}, "12", 3)).toBe("drive-pr 12 driver 3");
  });
});

describe("dispatchedFrom", () => {
  it("reads a launch record from the launch, else from the arm's variable", () => {
    expect(dispatchedFrom({ JIG_DISPATCHED_FROM: ` ${LAUNCH} ` })).toBe(LAUNCH);
    expect(dispatchedFrom({ JIG_LAUNCH: LAUNCH })).toBe(LAUNCH);
    expect(
      dispatchedFrom({
        JIG_DISPATCHED_FROM: LAUNCH,
        JIG_LAUNCH: "drive-pr 12 driver 3",
      }),
    ).toBe(LAUNCH);
    expect(
      dispatchedFrom({
        JIG_DISPATCHED_FROM: "20261105T080000Z-00000000",
        JIG_LAUNCH: LAUNCH,
      }),
    ).toBe(LAUNCH);
  });

  it("finds none where neither names a launch record", () => {
    expect(dispatchedFrom({})).toBeNull();
    expect(dispatchedFrom({ JIG_LAUNCH: "drive-pr 12 driver 3" })).toBeNull();
    expect(
      dispatchedFrom({
        JIG_DISPATCHED_FROM: "a person",
        JIG_LAUNCH: "drive-pr 12 driver 3",
      }),
    ).toBeNull();
  });
});

describe("passLaunchEnv", () => {
  it("keeps the driver's name as the launch of a drive armed in a tab, and hands on where it came from", () => {
    expect(passLaunchEnv({ JIG_DISPATCHED_FROM: LAUNCH }, "12", 3)).toEqual({
      JIG_LAUNCH: "drive-pr 12 driver 3",
      JIG_DISPATCHED_FROM: LAUNCH,
    });
  });

  it("hands a drive that runs under a dispatched launch both", () => {
    expect(passLaunchEnv({ JIG_LAUNCH: LAUNCH }, "12", 3)).toEqual({
      JIG_LAUNCH: LAUNCH,
      JIG_DISPATCHED_FROM: LAUNCH,
    });
  });

  it("hands a drive a person armed only the driver's name", () => {
    expect(passLaunchEnv({}, "12", 3)).toEqual({
      JIG_LAUNCH: "drive-pr 12 driver 3",
    });
  });
});
