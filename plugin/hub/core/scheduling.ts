/**
 * The scheduling port: run a named job at a time or on a cadence, and run
 * one soon ([design/control-plane.md § Concurrency and failures](../../../design/control-plane.md#concurrency-and-failures)).
 *
 * The core's background work (the sweep, the silent-host check, trimming
 * old rows) runs only as jobs. The adapter keeps each job's next run where
 * it survives a restart (process timers with the next run in storage,
 * Durable Object alarms) and runs each run of a job as one unit
 * (`runUnit`) through the `JobHandler` the core gives it for that name.
 * A job is idempotent and resumes from progress it stores; its lease row
 * keeps two runs of one job from overlapping.
 */
import type { Outcome } from "../../shared/outcome.ts";
import type { UnitContext } from "./unit.ts";

/** How a scheduling call fails: the adapter could not keep the schedule (`unavailable`), no handler holds the name (`unknown-job`), or the unit's signal stopped the call (`aborted`). */
export type SchedulingFailureCode = "unavailable" | "unknown-job" | "aborted";

/** When a job runs: once at a moment, or every `everyMs` from its first run. */
export type JobTiming =
  | { readonly at: number }
  | { readonly everyMs: number; readonly firstAt?: number };

/** One run of a job, as its handler receives it. */
export interface JobRun {
  readonly job: string;
  /** When this run was due, epoch milliseconds. */
  readonly dueAt: number;
}

/** The core's side of a job: one run. */
export type JobHandler = (
  context: UnitContext,
  run: JobRun,
) => Promise<Outcome<void>>;

export interface SchedulingPort {
  /** Runs `job` when `timing` says, replacing any schedule it had. */
  schedule(
    context: UnitContext,
    job: string,
    timing: JobTiming,
  ): Promise<Outcome<void, SchedulingFailureCode>>;
  /** Runs `job` once as soon as the adapter can, beside its schedule. */
  runSoon(
    context: UnitContext,
    job: string,
  ): Promise<Outcome<void, SchedulingFailureCode>>;
  /** Stops scheduling `job`; a run already started finishes. */
  cancel(
    context: UnitContext,
    job: string,
  ): Promise<Outcome<void, SchedulingFailureCode>>;
}
