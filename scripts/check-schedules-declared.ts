// Scope: Jig's own CI (`.github/workflows/`), through M11's heartbeat check
// (modules/M11-process-observability/reference/heartbeat): every workflow with
// a `schedule:` trigger must be a job in `.config/scheduled-jobs.yaml`, with
// the cadence it is expected to produce a result at. Exit 1 for a scheduled
// workflow that is not declared; 2 when the registry or a workflow cannot be
// read.
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { checkSchedulesDeclared as check } from "../modules/M11-process-observability/reference/heartbeat/check-schedules-declared.ts";

export function checkSchedulesDeclared(root = "."): number {
  try {
    return check(
      join(root, ".config/scheduled-jobs.yaml"),
      join(root, ".github/workflows"),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
if (import.meta.main) cli(() => checkSchedulesDeclared(process.argv[2]));
