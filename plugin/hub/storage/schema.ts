/**
 * The hub's tables, declared once in Drizzle's SQLite dialect
 * ([design/control-plane.md § Storage](../../../design/control-plane.md#storage)).
 *
 * Every table is partitioned (`plugin/hub/core/partitions.ts`): its first
 * column is `partition`, and its primary key and every index start with
 * it, so a statement that filters on its partition reads that partition's
 * rows only, and an adapter that keeps each partition apart (a Durable
 * Object each) runs the same schema. Times are integer epoch milliseconds
 * in columns named `*_at`; a body is JSON text.
 *
 * `drizzle-kit` generates the migrations in `migrations/` from this file:
 * `bun tools/hub/migrations.ts` after a change here, never an edit by hand.
 * Each table is registered in the records registry
 * (`plugin/shared/records/registry-hub.ts`).
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "../../shared/vendor/drizzle.mjs";

/**
 * One read of a target at a time: the unit reading `target` through, and
 * the moment another unit may take the read over.
 */
export const inFlightReads = sqliteTable(
  "in_flight_reads",
  {
    partition: text("partition").notNull(),
    target: text("target").notNull(),
    holder: text("holder").notNull(),
    takenAt: integer("taken_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.partition, table.target] }),
    index("in_flight_reads_deadline").on(table.partition, table.deadlineAt),
  ],
);

/**
 * One scheduled job's lease: the run that holds it and until when, and the
 * progress a run stores so the next resumes where it stopped.
 */
export const jobLeases = sqliteTable(
  "job_leases",
  {
    partition: text("partition").notNull(),
    job: text("job").notNull(),
    holder: text("holder"),
    leaseUntil: integer("lease_until"),
    progress: text("progress"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.partition, table.job] })],
);

/**
 * One scheduled job's next run, kept so a restarted hub runs it when it
 * was due: the moment it is due, and its cadence when it repeats (`null`
 * for a run at one moment, whose row goes once it has run).
 */
export const jobSchedules = sqliteTable(
  "job_schedules",
  {
    partition: text("partition").notNull(),
    job: text("job").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    everyMs: integer("every_ms"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.partition, table.job] })],
);
