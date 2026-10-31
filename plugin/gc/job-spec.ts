/**
 * Which scheduled job the platform scheduler code writes: its names on each
 * scheduler, where its launcher and logs live, what it runs and when. `jig
 * gc install` writes the daily collection; `jig dispatch install` writes the
 * dispatcher's tick, every few minutes, on the same code.
 */
import { stateRoot as gcStateRoot } from "./receipts.ts";

export interface JobSpec {
  /** The systemd units' and cron marker's name, e.g. `jig-gc`. */
  name: string;
  /** The launchd label, e.g. `dev.jig.gc`. */
  label: string;
  /** The service's description. */
  description: string;
  /** The timer's description. */
  timerDescription: string;
  /** Where the job's launcher and the scheduler's logs live. */
  stateRoot: string;
  /** The installed `jig.ts` arguments the job runs. */
  args: string[];
  /** A local hour every day, or every so many minutes. */
  schedule: { hour: number } | { everyMinutes: number };
  /** Extra environment the job runs with, beyond the scheduler's own. */
  env?: Record<string, string>;
  /** Seconds one run may take before the launcher stops it; the launcher's own bound when unset. */
  deadlineSec?: number;
}

/** Resource collection's daily job. */
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
