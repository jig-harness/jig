/**
 * The launch a session the line started carries: none outside one, the
 * dispatcher's launch record inside a dispatched one, and for a drive's pass
 * that inherited none, the driver itself.
 */
import { describe, expect, it } from "bun:test";
import { launchOf, passLaunch } from "../launched-session.ts";

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
