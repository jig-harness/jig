import { expect, test } from "bun:test";
import * as sharedCli from "../../../shared/cli.ts";
import * as sharedProc from "../../../shared/proc.ts";
import * as driveCli from "../scripts/lib/cli.ts";
import * as driveProc from "../scripts/lib/proc.ts";

test("drive CLI and process wrappers reuse the shared primitives", () => {
  expect(driveCli.isDigits).toBe(sharedCli.isDigits);
  expect(driveCli.shellQuote).toBe(sharedCli.shellQuote);
  expect(driveCli.readStdinAll).toBe(sharedCli.readStdinAll);
  expect(driveCli.sleep).toBe(sharedCli.sleep);
  expect(driveProc.ghCallTimeoutSeconds).toBe(sharedProc.ghCallTimeoutSeconds);
  expect(driveProc.tsArgv).toBe(sharedProc.tsArgv);
});
