/** Resource collection's scheduled job, on the shared scheduler code (`runtime/scheduler.ts`). */
import type { JobSpec } from "../runtime/job-spec.ts";
import { stateRoot as gcStateRoot } from "./receipts.ts";

/** Resource collection's daily job, at the machine file's `hour`. */
export function gcJobSpec(hour = 4): JobSpec {
  return {
    name: "jig-gc",
    label: "dev.jig.gc",
    description: "Jig resource collection",
    timerDescription: "Daily Jig resource report",
    stateRoot: gcStateRoot(),
    args: ["gc", "--scheduled"],
    schedule: { hour },
  };
}
