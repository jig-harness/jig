/**
 * The trimming job: deletes what the hub keeps longer than it should, once
 * an hour ([design/control-plane.md § How long it keeps things](../../../design/control-plane.md#how-long-it-keeps-things)).
 *
 * Each table that holds rows of limited life declares a retention rule:
 * the table, the time column its rows age by, and how long a row is kept
 * after that time. The job walks every partition the hub knows and every
 * rule, deleting a chunk of expired rows at a time through the storage
 * operation `trimExpired`, which reads them through the table's
 * (partition, time) index. Its position (the partition and the rule it is
 * on) is the job's stored progress, so a run that stops resumes where it
 * was, and a run that trims nothing more finishes. A partition the lister
 * names that does not parse is skipped and reported as an event
 * (`hub.trim.partition-skipped`), so one bad name never stops the walk.
 *
 * The periods the design sets are named here for the tables that keep
 * those things; a table's rule is declared when the table arrives.
 */
import { Defect, ok, type Outcome } from "../../shared/outcome.ts";
import { type JobFailureCode, runJob } from "./jobs.ts";
import { trimExpired } from "./operations.ts";
import { DIRECTORY_PARTITION, parsePartition } from "./partitions.ts";
import type { HubPorts } from "./ports.ts";
import type { JobHandler, SchedulingFailureCode } from "./scheduling.ts";
import type { UnitContext } from "./unit.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long the hub keeps each kind of thing, in milliseconds. */
export const RETENTION = {
  /** The change log of target versions. */
  changeLog: DAY_MS,
  /** Admitted delivery ids, so a late duplicate is still recognized. */
  deliveryIds: 7 * DAY_MS,
  /** A delivery's body, after it is applied. */
  deliveryBodyAfterApplied: DAY_MS,
  /** Bodies and validators of conditional reads, since their last use. */
  conditionalReadSinceUse: DAY_MS,
  /** World-view facts of closed work, after the work closed. */
  closedWorkFacts: 7 * DAY_MS,
  /** Copies of host records, after their work closed. */
  hostRecordCopies: 30 * DAY_MS,
  /** The cost ledger's hourly totals. */
  costLedger: 35 * DAY_MS,
  /** Structured logs. */
  logs: 14 * DAY_MS,
  /** The audit trail of enrollment, approval, scope changes, revocation and rotations. */
  auditTrail: 365 * DAY_MS,
  /** An in-flight read's row, after its deadline. */
  inFlightReadAfterDeadline: DAY_MS,
} as const;

/** One table's retention: its rows are deleted `keepMs` after the time in `column`. */
export interface RetentionRule {
  readonly table: string;
  readonly column: string;
  readonly keepMs: number;
}

/** Every table's retention rule. */
const RETENTION_RULES: readonly RetentionRule[] = [
  {
    table: "in_flight_reads",
    column: "deadline_at",
    keepMs: RETENTION.inFlightReadAfterDeadline,
  },
];

/** The trimming job's name. */
export const TRIM_JOB = "trim";
/** How often the trimming job runs. */
export const TRIM_EVERY_MS = HOUR_MS;
/** How many rows one step deletes at most. */
const TRIM_CHUNK = 500;
/** How long one run of the trimming job may take. */
const TRIM_TIMEOUT_MS = 10 * 60 * 1000;
/** How long the trimming job's lease lasts: as long as a run may take, so it outlives the run. */
const TRIM_LEASE_MS = TRIM_TIMEOUT_MS;

/** Schedules the trimming job to run every hour. */
export function scheduleTrimming(
  ports: Pick<HubPorts, "scheduling">,
  context: UnitContext,
): Promise<Outcome<void, SchedulingFailureCode>> {
  return ports.scheduling.schedule(context, TRIM_JOB, {
    everyMs: TRIM_EVERY_MS,
  });
}

/** Where a run of the trimming job is: the partition and the rule it trims next. */
type TrimProgress = {
  readonly partition: string;
  readonly rule: number;
};

/** The partitions the hub knows, in any order; the job sorts them. */
export type PartitionLister = (
  context: UnitContext,
) => Promise<Outcome<readonly string[], string>>;

export interface TrimmingOptions {
  /** Lists the partitions to trim. */
  readonly partitions: PartitionLister;
  /** The rules to apply; every table's (`RETENTION_RULES`) when absent. */
  readonly rules?: readonly RetentionRule[];
  /** Rows one step deletes at most; `TRIM_CHUNK` when absent. */
  readonly chunk?: number;
  /** This run's holder id, for a test; a fresh random one when absent. */
  readonly holder?: string;
}

/** The first (partition, rule) at or after `at` in sorted `partitions`, or `null` when none is left. */
function position(
  partitions: readonly string[],
  rules: number,
  at: TrimProgress | null,
): TrimProgress | null {
  if (rules === 0) return null;
  if (at === null) {
    const first = partitions[0];
    return first === undefined ? null : { partition: first, rule: 0 };
  }
  if (partitions.includes(at.partition) && at.rule < rules) return at;
  const next = partitions.find((p) => p > at.partition);
  return next === undefined ? null : { partition: next, rule: 0 };
}

/** The position after `at`: the next rule, or the next partition's first. */
function after(
  partitions: readonly string[],
  rules: number,
  at: TrimProgress,
): TrimProgress | null {
  return at.rule + 1 < rules
    ? { partition: at.partition, rule: at.rule + 1 }
    : position(partitions, rules, { partition: at.partition, rule: rules });
}

/**
 * The trimming job's handler: one run walks every partition and rule from
 * its stored position, a chunk of rows a step, under the job's lease (kept
 * in the directory partition).
 */
export function trimmingHandler(
  ports: Pick<HubPorts, "clock" | "observability" | "storage">,
  options: TrimmingOptions,
): JobHandler {
  const rules = options.rules ?? RETENTION_RULES;
  const chunk = options.chunk ?? TRIM_CHUNK;
  return async (context, run) => {
    // A negative or fractional retention makes a cutoff in the future, which
    // deletes rows still held (an in-flight read's deadline among them).
    for (const rule of rules)
      if (!Number.isSafeInteger(rule.keepMs) || rule.keepMs < 0)
        throw new Defect(
          `the retention rule for ${rule.table}.${rule.column} keeps ${rule.keepMs} ms; it must be a whole, nonnegative number of milliseconds`,
        );
    const listed = await options.partitions(context);
    if (!listed.ok) return listed;
    const partitions = [...listed.value].sort((a, b) => a.localeCompare(b));
    const remainingMs = context.deadlineAt - ports.clock.now();
    const ran = await runJob<TrimProgress, JobFailureCode>(
      ports,
      {
        job: run.job,
        partition: DIRECTORY_PARTITION,
        timeoutMs: Math.max(1, Math.min(TRIM_TIMEOUT_MS, remainingMs)),
        leaseMs: TRIM_LEASE_MS,
        stop: context.signal,
        ...(options.holder === undefined ? {} : { holder: options.holder }),
      },
      async (unit, progress) => {
        const at = position(partitions, rules.length, progress);
        if (at === null)
          return ok({ progress: { partition: "", rule: 0 }, done: true });
        const parsed = parsePartition(at.partition);
        if (!parsed.ok) {
          ports.observability.event(unit, {
            name: "hub.trim.partition-skipped",
            at: ports.clock.now(),
            code: parsed.failure.code,
            fields: { partition: at.partition, reason: parsed.failure.reason },
          });
          const past = position(partitions, rules.length, {
            partition: at.partition,
            rule: rules.length,
          });
          return past === null
            ? ok({ progress: at, done: true })
            : ok({ progress: past, done: false });
        }
        const rule = rules[at.rule] as RetentionRule;
        const trimmed = await ports.storage.run(
          unit,
          at.partition,
          trimExpired,
          {
            table: rule.table,
            column: rule.column,
            before: ports.clock.now() - rule.keepMs,
            limit: chunk,
          },
        );
        if (!trimmed.ok) return trimmed;
        // A full chunk may leave more: the same position runs again.
        if (trimmed.value.deleted >= chunk)
          return ok({ progress: at, done: false });
        const next = after(partitions, rules.length, at);
        return next === null
          ? ok({ progress: at, done: true })
          : ok({ progress: next, done: false });
      },
    );
    return ran.ok ? ok(undefined) : ran;
  };
}
