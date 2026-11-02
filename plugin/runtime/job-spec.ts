/**
 * Which scheduled job the platform scheduler code writes: its names on each
 * scheduler, where its launcher and logs live, what it runs and when. Each
 * component of the `jig` command names its own: resource collection's daily
 * run (`gc/job-spec.ts`) and the dispatcher's tick, every few minutes
 * (`dispatch/install.ts`), both written by the same code.
 */
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
