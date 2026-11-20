/**
 * The job helper: runs one run of a scheduled job under its deadline and
 * its lease ([design/control-plane.md § Concurrency and failures](../../../design/control-plane.md#concurrency-and-failures)).
 *
 * Background work runs only as jobs, each idempotent, resumable from the
 * progress it stores, and held by a lease row so two runs of one job never
 * overlap. A run is one unit (`runUnit`): it takes the job's lease row,
 * reads the progress an earlier run left, and runs the job's steps one at a
 * time, storing the progress after each while it still holds the lease and
 * renewing the lease as it does. It stops when the unit's signal aborts,
 * when its deadline passes, or when another run took the lease over, and
 * it finishes the job (clearing its progress and lease) when a step says
 * it is done. A run that finds the lease held by a live run does not run
 * at all, which is no failure.
 *
 * A run that stops early leaves its lease to lapse and its progress
 * stored: the next run after the lease lapsed resumes from that progress,
 * and redoes at most the step that was running, which is why each step is
 * idempotent.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  finishJob,
  type JsonValue,
  saveJobProgress,
  takeJobLease,
} from "./operations.ts";
import type { HubPorts } from "./ports.ts";
import type { StorageFailureCode } from "./storage.ts";
import { runUnit, type UnitContext, type UnitOutcome } from "./unit.ts";

export interface JobSpec {
  /** The job's name, its lease row's key. */
  readonly job: string;
  /** The partition the lease row lives in. */
  readonly partition: string;
  /** How long one run may take, a positive whole number of milliseconds. */
  readonly timeoutMs: number;
  /**
   * How long a lease lasts from its last renewal; a run that stops without
   * finishing blocks the next run this long. Longer than any one step.
   */
  readonly leaseMs: number;
  /** This run's holder id; a fresh random one when absent. */
  readonly holder?: string;
  /** The caller's signal, when it can stop the run early. */
  readonly stop?: AbortSignal;
}

/** What one step answers: the progress to store, and whether the job is done. */
export interface StepResult<Progress extends JsonValue> {
  readonly progress: Progress;
  readonly done: boolean;
}

/**
 * One step of a job, from the progress the last step stored (`null` when
 * the job starts afresh). A step is idempotent: a run that stops during it
 * leaves the next run to do it again.
 */
export type JobStep<Progress extends JsonValue, Code extends string> = (
  context: UnitContext,
  progress: Progress | null,
) => Promise<Outcome<StepResult<Progress>, Code>>;

/** What a run did: nothing, since another run holds the lease, or how many steps it ran to the job's end. */
export type JobRunAnswer =
  | { readonly ran: false; readonly holder: string; readonly until: number }
  | { readonly ran: true; readonly steps: number };

/** How a run fails beyond its steps' own codes: the store, or a lease another run took. */
export type JobFailureCode = StorageFailureCode | "lease-lost";

/**
 * Runs one run of `spec.job` as one unit, under its lease, from its stored
 * progress until a step says it is done.
 */
export function runJob<Progress extends JsonValue, Code extends string>(
  ports: Pick<HubPorts, "clock" | "observability" | "storage">,
  spec: JobSpec,
  step: JobStep<Progress, Code>,
): Promise<UnitOutcome<JobRunAnswer, Code | JobFailureCode>> {
  const { job, partition, leaseMs } = spec;
  const holder = spec.holder ?? crypto.randomUUID();
  const lost = () =>
    failed(
      "lease-lost",
      `the run ${holder} of ${job} no longer holds its lease; another run took it over`,
    );
  return runUnit<JobRunAnswer, Code | JobFailureCode>(
    ports,
    {
      name: `job:${job}`,
      timeoutMs: spec.timeoutMs,
      ...(spec.stop === undefined ? {} : { stop: spec.stop }),
    },
    async (context) => {
      const lease = await ports.storage.run(context, partition, takeJobLease, {
        job,
        holder,
        now: ports.clock.now(),
        leaseMs,
      });
      if (!lease.ok) return lease;
      if (!lease.value.taken)
        return ok({
          ran: false,
          holder: lease.value.holder,
          until: lease.value.until,
        });
      let progress = lease.value.progress as Progress | null;
      for (let steps = 1; ; steps++) {
        if (context.signal.aborted)
          return failed("aborted", `the run of ${job} was stopped`);
        const stepped = await step(context, progress);
        if (!stepped.ok) return stepped;
        progress = stepped.value.progress;
        const now = ports.clock.now();
        if (stepped.value.done) {
          const finished = await ports.storage.run(
            context,
            partition,
            finishJob,
            { job, holder, now },
          );
          if (!finished.ok) return finished;
          return finished.value.finished ? ok({ ran: true, steps }) : lost();
        }
        const saved = await ports.storage.run(
          context,
          partition,
          saveJobProgress,
          { job, holder, now, leaseMs, progress },
        );
        if (!saved.ok) return saved;
        if (!saved.value.saved) return lost();
      }
    },
  );
}
