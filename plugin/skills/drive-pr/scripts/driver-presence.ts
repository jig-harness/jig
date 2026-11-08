/**
 * `driver-presence.ts <PR> <clone key> <started>`: what this host shows of
 * the driver run a drive ledger names, as one JSON line,
 * `{"verdict":"gone"|"present"|"unknown","why":"…"}`
 * (`lib/driver-presence.ts`). Read-only: the drive's database is opened only
 * when it is already current, and nothing is written. Exit 2 on a usage
 * error.
 */
import { fail, runMain } from "./lib/cli.ts";
import { driverPresence, recordedRun } from "./lib/driver-presence.ts";
import { READ_ONLY_ENV } from "./lib/state/db.ts";

async function main(argv: string[]): Promise<number> {
  const run = recordedRun(argv);
  if (run === null)
    fail(2, "usage: driver-presence.ts <PR> <clone key> <started>");
  process.env[READ_ONLY_ENV] = "1";
  console.log(JSON.stringify(await driverPresence(run)));
  return 0;
}

if (import.meta.main)
  runMain("driver-presence.ts", () => main(process.argv.slice(2)));
