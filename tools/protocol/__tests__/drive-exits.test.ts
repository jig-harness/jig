/**
 * The drive-exits chapter publishes `drive-status.ts`'s column only for the
 * states a `drive-status.ts` report can carry.
 */
import { describe, expect, test } from "bun:test";
import { DRIVE_EXITS } from "../chapters/drive-exits.ts";

const value = (name: string) => {
  const found = DRIVE_EXITS.values().find((v) => v.name === name);
  if (found === undefined) throw new Error(`no drive-exits value ${name}`);
  return found;
};

describe("drive-exits: drive-status.ts's contract", () => {
  test("UNSUPPORTED_CLI is drive.ts's refusal to start, never a drive-status.ts report state", () => {
    expect(value("UNSUPPORTED_CLI")).toMatchObject({
      kind: "driver-only",
      exit: 2,
      driveStatusExit: null,
      driveExit: 2,
    });
  });

  test("no state at exit 2 is published for drive-status.ts", () => {
    const atTwo = DRIVE_EXITS.values().filter((v) => v.exit === 2);
    expect(atTwo.length).toBeGreaterThan(0);
    expect(atTwo.filter((v) => v.driveStatusExit !== null)).toEqual([]);
  });
});
