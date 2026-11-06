/**
 * `driveExitName`: the registry's name for each exit `drive.ts` ends with,
 * which a reader of another component (`jig ask`) prints as a drive's state,
 * and `null` for a code `drive.ts` never exits with.
 */
import { describe, expect, it } from "bun:test";
import {
  DRIVE_EXIT,
  driveExitName,
} from "../scripts/lib/status/terminal-states.ts";

describe("driveExitName", () => {
  it("names every exit drive.ts ends with by the first state the registry gives it", () => {
    for (const [name, code] of Object.entries(DRIVE_EXIT)) {
      const named = driveExitName(code);
      expect(named).not.toBeNull();
      expect(DRIVE_EXIT[named as keyof typeof DRIVE_EXIT]).toBe(code);
      if (named !== name)
        // Two states share a code: the driver's own refusal names it.
        expect(named).toBe("SINGLE_INSTANCE_LOCK");
    }
    expect(driveExitName(DRIVE_EXIT.CONVERGED)).toBe("CONVERGED");
    expect(driveExitName(DRIVE_EXIT.HITL_PARKED)).toBe("HITL_PARKED");
  });

  it("names no state for a code drive.ts never exits with", () => {
    expect(driveExitName(10)).toBeNull();
    expect(driveExitName(255)).toBeNull();
  });
});
