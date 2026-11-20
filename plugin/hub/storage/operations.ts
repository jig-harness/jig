/**
 * The one implementation of each storage operation the core names
 * (`plugin/hub/core/operations.ts`), written with Drizzle's SQLite query
 * builder over a synchronous database: `bun:sqlite` and Durable Object
 * SQLite both give one, so every adapter runs these same statements
 * ([design/control-plane.md § Storage](../../../design/control-plane.md#storage)).
 *
 * An implementation prepares every statement it will send before it sends
 * the first, and its `run` sends them with no await between them, so the
 * storage implementation (`storage.ts`) commits a change's statements in
 * one synchronous transaction. Every statement filters on, or writes, the
 * partition it was prepared for. A decision sits in a statement's
 * condition (an insert that takes a row only where it is free), never in
 * code between a read and a write: `run` reads what a conditional
 * statement returned to say whether it applied. What breaks an invariant
 * the statements keep (a row a conflict proved there that a read then
 * misses, a stored progress cell that is not JSON) is a `Defect`, thrown to
 * the unit's boundary, never answered as data.
 */
import { Defect, failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  and,
  type BaseSQLiteDatabase,
  eq,
  inArray,
  lt,
  lte,
  type SQLiteColumn,
  type SQLiteTable,
  sql,
} from "../../shared/vendor/drizzle.mjs";
import {
  finishJob,
  IN_FLIGHT_READ_MS,
  type JsonValue,
  readInFlightRead,
  readJob,
  releaseInFlightRead,
  saveJobProgress,
  takeInFlightRead,
  takeJobLease,
  trimExpired,
} from "../core/operations.ts";
import type { StorageOperation } from "../core/storage.ts";
import { inFlightReads, jobLeases } from "./schema.ts";

/** A synchronous SQLite database through Drizzle, as every adapter opens one. */
export type HubDatabase = BaseSQLiteDatabase<"sync", unknown>;

/** A statement prepared to be sent: its SQL and parameters, for a query plan. */
export interface PreparedStatement {
  getQuery(): { sql: string; params: unknown[] };
}

/** An operation's statements, prepared, and how to send them for its result. */
export interface Prepared<Result> {
  readonly statements: readonly PreparedStatement[];
  /** Sends the statements, synchronously, and reads the result. */
  run(): Result;
}

/** One operation's implementation: prepares its statements for one partition and input. */
export interface Implementation<Input, Result> {
  readonly op: StorageOperation<Input, Result>;
  prepare(
    db: HubDatabase,
    partition: string,
    input: Input,
  ): Outcome<Prepared<Result>, "refused">;
}

function implement<Input, Result>(
  op: StorageOperation<Input, Result>,
  prepare: Implementation<Input, Result>["prepare"],
): Implementation<Input, Result> {
  return { op, prepare };
}

/** The first row a statement returned, if any. */
function first<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}

/** Whether `value` is a whole number of milliseconds a time column holds. */
function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** A refusal for input no correct statement can be prepared from. */
function refuse(
  op: string,
  reason: string,
): { ok: false; failure: { code: "refused"; reason: string } } {
  return failed("refused", `${op}: ${reason}`);
}

const takeInFlightReadImpl = implement(
  takeInFlightRead,
  (db, partition, { target, holder, now }) => {
    if (!isTime(now)) return refuse(takeInFlightRead.name, "now is no time");
    const deadlineAt = now + IN_FLIGHT_READ_MS;
    const take = db
      .insert(inFlightReads)
      .values({ partition, target, holder, takenAt: now, deadlineAt })
      .onConflictDoUpdate({
        target: [inFlightReads.partition, inFlightReads.target],
        set: { holder, takenAt: now, deadlineAt },
        setWhere: lte(inFlightReads.deadlineAt, now),
      })
      .returning({ deadlineAt: inFlightReads.deadlineAt })
      .prepare();
    const held = db
      .select({ holder: inFlightReads.holder, until: inFlightReads.deadlineAt })
      .from(inFlightReads)
      .where(
        and(
          eq(inFlightReads.partition, partition),
          eq(inFlightReads.target, target),
        ),
      )
      .prepare();
    return ok({
      statements: [take, held],
      run: () => {
        const taken = first(take.all());
        if (taken !== undefined)
          return { taken: true, until: taken.deadlineAt } as const;
        // The row the insert conflicted with is there in this transaction.
        const row = first(held.all());
        if (row === undefined)
          throw new Defect(
            `the in-flight read of ${target} in ${partition} was neither taken nor found`,
          );
        return { taken: false, holder: row.holder, until: row.until } as const;
      },
    });
  },
);

const releaseInFlightReadImpl = implement(
  releaseInFlightRead,
  (db, partition, { target, holder }) => {
    const release = db
      .delete(inFlightReads)
      .where(
        and(
          eq(inFlightReads.partition, partition),
          eq(inFlightReads.target, target),
          eq(inFlightReads.holder, holder),
        ),
      )
      .returning({ target: inFlightReads.target })
      .prepare();
    return ok({
      statements: [release],
      run: () => ({ released: release.all().length > 0 }),
    });
  },
);

const readInFlightReadImpl = implement(
  readInFlightRead,
  (db, partition, { target }) => {
    const read = db
      .select({
        target: inFlightReads.target,
        holder: inFlightReads.holder,
        takenAt: inFlightReads.takenAt,
        deadlineAt: inFlightReads.deadlineAt,
      })
      .from(inFlightReads)
      .where(
        and(
          eq(inFlightReads.partition, partition),
          eq(inFlightReads.target, target),
        ),
      )
      .prepare();
    return ok({
      statements: [read],
      run: () => first(read.all()) ?? null,
    });
  },
);

/** Whether `value` is what JSON text parses to. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      // JSON text has no NaN or Infinity: they would be stored as null.
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

/**
 * `job`'s stored progress as the value it was stored from; `null` when none
 * is stored. Only `saveJobProgress` writes it, as JSON, so a cell that does
 * not parse is a broken invariant: a defect, which the unit's boundary
 * reports, never progress a run would resume from.
 */
function progressOf(job: string, text: string | null): JsonValue | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Defect(`the stored progress of ${job} is not JSON`, {
      cause: error,
    });
  }
  if (!isJsonValue(parsed))
    throw new Defect(`the stored progress of ${job} is not a JSON value`);
  return parsed;
}

const takeJobLeaseImpl = implement(
  takeJobLease,
  (db, partition, { job, holder, now, leaseMs }) => {
    if (!isTime(now) || !isTime(leaseMs) || leaseMs <= 0)
      return refuse(
        takeJobLease.name,
        "now and leaseMs must be whole milliseconds, leaseMs above 0",
      );
    const until = now + leaseMs;
    const take = db
      .insert(jobLeases)
      .values({
        partition,
        job,
        holder,
        leaseUntil: until,
        startedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [jobLeases.partition, jobLeases.job],
        set: {
          holder,
          leaseUntil: until,
          updatedAt: now,
          startedAt: now,
        },
        // Free or lapsed; a live lease is never taken again, not even by
        // its own holder's id, so two runs given one id cannot both run.
        setWhere: sql`${jobLeases.holder} is null or ${jobLeases.leaseUntil} is null or ${jobLeases.leaseUntil} <= ${now}`,
      })
      .returning({ progress: jobLeases.progress })
      .prepare();
    const held = db
      .select({ holder: jobLeases.holder, until: jobLeases.leaseUntil })
      .from(jobLeases)
      .where(and(eq(jobLeases.partition, partition), eq(jobLeases.job, job)))
      .prepare();
    return ok({
      statements: [take, held],
      run: () => {
        const taken = first(take.all());
        if (taken !== undefined)
          return {
            taken: true,
            until,
            progress: progressOf(job, taken.progress),
          } as const;
        // A lease not taken is held: a holder and an unlapsed time.
        const row = first(held.all());
        if (row?.holder == null || row.until === null)
          throw new Defect(
            `the lease of ${job} in ${partition} was neither taken nor found held`,
          );
        return { taken: false, holder: row.holder, until: row.until } as const;
      },
    });
  },
);

const saveJobProgressImpl = implement(
  saveJobProgress,
  (db, partition, { job, holder, now, leaseMs, progress }) => {
    if (!isTime(now) || !isTime(leaseMs) || leaseMs <= 0)
      return refuse(
        saveJobProgress.name,
        "now and leaseMs must be whole milliseconds, leaseMs above 0",
      );
    if (!isJsonValue(progress))
      return refuse(
        saveJobProgress.name,
        "progress must survive JSON unchanged: no NaN, Infinity or undefined",
      );
    const save = db
      .update(jobLeases)
      .set({
        progress: JSON.stringify(progress),
        leaseUntil: now + leaseMs,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobLeases.partition, partition),
          eq(jobLeases.job, job),
          eq(jobLeases.holder, holder),
          sql`${jobLeases.leaseUntil} > ${now}`,
        ),
      )
      .returning({ job: jobLeases.job })
      .prepare();
    return ok({
      statements: [save],
      run: () => ({ saved: save.all().length > 0 }),
    });
  },
);

const finishJobImpl = implement(
  finishJob,
  (db, partition, { job, holder, now }) => {
    if (!isTime(now)) return refuse(finishJob.name, "now is no time");
    const finish = db
      .update(jobLeases)
      .set({
        holder: null,
        leaseUntil: null,
        progress: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobLeases.partition, partition),
          eq(jobLeases.job, job),
          eq(jobLeases.holder, holder),
        ),
      )
      .returning({ job: jobLeases.job })
      .prepare();
    return ok({
      statements: [finish],
      run: () => ({ finished: finish.all().length > 0 }),
    });
  },
);

const readJobImpl = implement(readJob, (db, partition, { job }) => {
  const read = db
    .select({
      job: jobLeases.job,
      holder: jobLeases.holder,
      leaseUntil: jobLeases.leaseUntil,
      progress: jobLeases.progress,
      startedAt: jobLeases.startedAt,
      finishedAt: jobLeases.finishedAt,
      updatedAt: jobLeases.updatedAt,
    })
    .from(jobLeases)
    .where(and(eq(jobLeases.partition, partition), eq(jobLeases.job, job)))
    .prepare();
  return ok({
    statements: [read],
    run: () => {
      const row = first(read.all());
      return row === undefined
        ? null
        : { ...row, progress: progressOf(job, row.progress) };
    },
  });
});

/**
 * The tables a retention rule may trim, and the time columns it may trim
 * them by: each the second column of an index that starts with the
 * partition, so a trim finds the partition's expired rows through that
 * index alone and deletes them by row id.
 */
const TRIMMABLE: Readonly<
  Record<
    string,
    {
      readonly table: SQLiteTable;
      readonly partition: SQLiteColumn;
      readonly columns: Readonly<Record<string, SQLiteColumn>>;
    }
  >
> = {
  in_flight_reads: {
    table: inFlightReads,
    partition: inFlightReads.partition,
    columns: { deadline_at: inFlightReads.deadlineAt },
  },
};

const trimExpiredImpl = implement(
  trimExpired,
  (db, partition, { table, column, before, limit }) => {
    const trimmable = Object.hasOwn(TRIMMABLE, table)
      ? TRIMMABLE[table]
      : undefined;
    const time =
      trimmable !== undefined && Object.hasOwn(trimmable.columns, column)
        ? trimmable.columns[column]
        : undefined;
    if (trimmable === undefined || time === undefined)
      return refuse(
        trimExpired.name,
        `no retention rule trims ${table}.${column}`,
      );
    if (!isTime(before) || !Number.isSafeInteger(limit) || limit <= 0)
      return refuse(
        trimExpired.name,
        "before must be whole milliseconds and limit a whole number above 0",
      );
    // The oldest expired rows of the partition, through its (partition,
    // time) index; the delete looks each up by its row id, so the subquery
    // holds the partition's filter for both.
    const oldest = db
      .select({ id: sql<number>`rowid` })
      .from(trimmable.table)
      .where(and(eq(trimmable.partition, partition), lt(time, before)))
      .orderBy(time)
      .limit(limit);
    const trim = db
      .delete(trimmable.table)
      .where(inArray(sql`rowid`, oldest))
      .returning({ id: sql<number>`rowid` })
      .prepare();
    return ok({
      statements: [trim],
      run: () => ({ deleted: trim.all().length }),
    });
  },
);

/** Every operation's implementation, by its name. */
export const IMPLEMENTATIONS: ReadonlyMap<
  string,
  Implementation<unknown, unknown>
> = new Map(
  (
    [
      takeInFlightReadImpl,
      releaseInFlightReadImpl,
      readInFlightReadImpl,
      takeJobLeaseImpl,
      saveJobProgressImpl,
      finishJobImpl,
      readJobImpl,
      trimExpiredImpl,
    ] as unknown as Implementation<unknown, unknown>[]
  ).map((implementation) => [implementation.op.name, implementation]),
);
