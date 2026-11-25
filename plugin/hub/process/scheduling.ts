/**
 * The process adapter's scheduling port: timers in the process, with each
 * job's next run kept in storage (`job_schedules`), so a restarted hub runs
 * each job when it was due
 * ([design/control-plane.md § The portable core and its adapters](../../../design/control-plane.md#the-portable-core-and-its-adapters)).
 *
 * A timer that fires stores the job's next run first, then hands the run
 * to the runner (`runner.ts`, the worker thread), never running it on the
 * listeners' thread. A job whose last run is still going is not started
 * again; its lease row (`core/jobs.ts`) holds that across processes too.
 * Scheduling an every-so-often job again with the same cadence keeps the
 * next run storage holds, so a restart does not push it back.
 */
import { Defect, failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  type JobSchedule,
  readJobSchedules,
  removeJobSchedule,
  saveJobSchedule,
} from "../core/operations.ts";
import { DIRECTORY_PARTITION } from "../core/partitions.ts";
import type { HubPorts } from "../core/ports.ts";
import type {
  JobTiming,
  SchedulingFailureCode,
  SchedulingPort,
} from "../core/scheduling.ts";
import type { StorageFailureCode } from "../core/storage.ts";
import { runUnit, type UnitContext } from "../core/unit.ts";
import type { JobRunner } from "./runner.ts";

/** The longest delay one timer takes; a later run is reached in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How long storing a fired job's next run may take. */
const FIRE_UNIT_MS = 10_000;

export interface ProcessScheduling extends SchedulingPort {
  /** Reads the stored schedules and arms a timer for each known job. */
  start(context: UnitContext): Promise<Outcome<void, SchedulingFailureCode>>;
  /** Clears every timer; runs already handed to the worker finish there. */
  stop(): void;
}

export interface SchedulingDeps {
  readonly ports: Pick<HubPorts, "storage" | "clock" | "observability">;
  readonly runner: Pick<JobRunner, "run">;
  /** The jobs the worker holds a handler for. */
  readonly knownJobs: readonly string[];
  readonly partition?: string;
}

/** A storage failure as a scheduling one. */
function asScheduling(failure: {
  code: StorageFailureCode;
  reason: string;
}): Outcome<never, SchedulingFailureCode> {
  return failed(
    failure.code === "aborted" ? "aborted" : "unavailable",
    failure.reason,
  );
}

/** The first moment after `now` on the cadence that started at `due`. */
function nextOnCadence(due: number, everyMs: number, now: number) {
  if (due > now) return due;
  return due + (Math.floor((now - due) / everyMs) + 1) * everyMs;
}

function checkTiming(job: string, timing: JobTiming): void {
  const whole = (value: number | undefined) =>
    value === undefined || Number.isSafeInteger(value);
  if ("at" in timing ? !whole(timing.at) : !whole(timing.firstAt))
    throw new Defect(`the schedule of ${job} names no whole millisecond`);
  if ("everyMs" in timing && (!whole(timing.everyMs) || timing.everyMs <= 0))
    throw new Defect(
      `the cadence of ${job} must be whole milliseconds above 0`,
    );
}

export function processScheduling(deps: SchedulingDeps): ProcessScheduling {
  const { ports, runner, knownJobs } = deps;
  const partition = deps.partition ?? DIRECTORY_PARTITION;
  const schedules = new Map<string, JobSchedule>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  let stopped = false;

  const unknown = (job: string) =>
    knownJobs.includes(job)
      ? null
      : failed("unknown-job", `no handler runs the job ${job}`);

  const report = (
    job: string,
    name: string,
    failure: { code: string; reason: string },
  ) =>
    runUnit(ports, { name: `job:${job}`, timeoutMs: 1_000 }, async (context) =>
      ports.observability.event(context, {
        name,
        at: ports.clock.now(),
        code: failure.code,
        fields: { job, reason: failure.reason },
      }),
    );

  /** Hands one run to the runner, unless the job's last run is still going. */
  const launch = (job: string, dueAt: number) => {
    if (running.has(job)) return;
    running.add(job);
    void runner.run(job, dueAt).then(async (ran) => {
      running.delete(job);
      if (!ran.ok) await report(job, "hub.job.failed", ran.failure);
    });
  };

  const disarm = (job: string) => {
    clearTimeout(timers.get(job));
    timers.delete(job);
  };

  const arm = (row: JobSchedule) => {
    disarm(row.job);
    if (stopped) return;
    const wait = row.nextRunAt - ports.clock.now();
    if (wait > MAX_TIMER_MS) {
      timers.set(
        row.job,
        setTimeout(() => arm(row), MAX_TIMER_MS),
      );
      return;
    }
    timers.set(
      row.job,
      setTimeout(() => void fire(row), Math.max(0, wait)),
    );
  };

  /** Stores the next run (or forgets a one-time job's), then runs this one. */
  const fire = async (row: JobSchedule) => {
    timers.delete(row.job);
    const kept = await runUnit(
      ports,
      { name: `schedule:${row.job}`, timeoutMs: FIRE_UNIT_MS },
      async (context): Promise<Outcome<void, string>> => {
        const now = ports.clock.now();
        if (row.everyMs === null) {
          const removed = await ports.storage.run(
            context,
            partition,
            removeJobSchedule,
            {
              job: row.job,
            },
          );
          if (!removed.ok) return removed;
          schedules.delete(row.job);
          return ok(undefined);
        }
        const next: JobSchedule = {
          ...row,
          nextRunAt: nextOnCadence(row.nextRunAt, row.everyMs, now),
          updatedAt: now,
        };
        const saved = await ports.storage.run(
          context,
          partition,
          saveJobSchedule,
          {
            job: row.job,
            nextRunAt: next.nextRunAt,
            everyMs: next.everyMs,
            now,
          },
        );
        if (!saved.ok) return saved;
        schedules.set(row.job, next);
        arm(next);
        return ok(undefined);
      },
    );
    if (!kept.ok) {
      await report(row.job, "hub.schedule.unsaved", kept.failure);
      // The run still happens; the stored schedule runs it again after a restart.
      if (row.everyMs !== null)
        arm({ ...row, nextRunAt: ports.clock.now() + row.everyMs });
    }
    if (!stopped) launch(row.job, row.nextRunAt);
  };

  return {
    start: async (context) => {
      const read = await ports.storage.run(
        context,
        partition,
        readJobSchedules,
        {},
      );
      if (!read.ok) return asScheduling(read.failure);
      for (const row of read.value) {
        if (!knownJobs.includes(row.job)) continue;
        schedules.set(row.job, row);
        arm(row);
      }
      return ok(undefined);
    },
    stop: () => {
      stopped = true;
      for (const job of [...timers.keys()]) disarm(job);
    },
    schedule: async (context, job, timing) => {
      const refused = unknown(job);
      if (refused !== null) return refused;
      checkTiming(job, timing);
      const now = ports.clock.now();
      const held = schedules.get(job);
      if (
        "everyMs" in timing &&
        timing.firstAt === undefined &&
        held?.everyMs === timing.everyMs
      ) {
        arm(held);
        return ok(undefined);
      }
      const row: JobSchedule =
        "at" in timing
          ? { job, nextRunAt: timing.at, everyMs: null, updatedAt: now }
          : {
              job,
              nextRunAt: timing.firstAt ?? now + timing.everyMs,
              everyMs: timing.everyMs,
              updatedAt: now,
            };
      const saved = await ports.storage.run(
        context,
        partition,
        saveJobSchedule,
        {
          job,
          nextRunAt: row.nextRunAt,
          everyMs: row.everyMs,
          now,
        },
      );
      if (!saved.ok) return asScheduling(saved.failure);
      schedules.set(job, row);
      arm(row);
      return ok(undefined);
    },
    runSoon: async (_context, job) => {
      const refused = unknown(job);
      if (refused !== null) return refused;
      launch(job, ports.clock.now());
      return ok(undefined);
    },
    cancel: async (context, job) => {
      const refused = unknown(job);
      if (refused !== null) return refused;
      disarm(job);
      schedules.delete(job);
      const removed = await ports.storage.run(
        context,
        partition,
        removeJobSchedule,
        {
          job,
        },
      );
      return removed.ok ? ok(undefined) : asScheduling(removed.failure);
    },
  };
}
