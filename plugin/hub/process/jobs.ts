/**
 * The hub's scheduled jobs, as the worker thread runs them: each job's
 * name and the handler the core gives for it, built over the worker's own
 * ports. The serve process schedules the names; the worker, with its own
 * connection to the database, runs the handlers, so a long run never holds
 * the listeners' thread.
 *
 * A module the worker loads holds `JOB_NAMES` and `jobHandlers`; a test
 * hands the worker one of its own.
 */
import { ok } from "../../shared/outcome.ts";
import { DIRECTORY_PARTITION } from "../core/partitions.ts";
import type { HubPorts } from "../core/ports.ts";
import type { JobHandler } from "../core/scheduling.ts";
import { TRIM_JOB, trimmingHandler } from "../core/trimming.ts";

/** What a module of jobs gives the worker and the scheduler. */
export interface JobModule {
  readonly JOB_NAMES: readonly string[];
  jobHandlers(ports: HubPorts): ReadonlyMap<string, JobHandler>;
}

export const JOB_NAMES: readonly string[] = [TRIM_JOB];

/**
 * The handlers by name. The trimming job walks the directory partition: the
 * repositories' and hosts' partitions join its list when enrollment and
 * the world view first write them.
 */
export function jobHandlers(ports: HubPorts): ReadonlyMap<string, JobHandler> {
  return new Map([
    [
      TRIM_JOB,
      trimmingHandler(ports, {
        partitions: async () => ok([DIRECTORY_PARTITION]),
      }),
    ],
  ]);
}
