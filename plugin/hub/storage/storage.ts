/**
 * The storage port over a synchronous SQLite database through Drizzle: the
 * one implementation every adapter hands the core
 * ([design/control-plane.md § Storage](../../../design/control-plane.md#storage)).
 *
 * An adapter opens its database (`bun:sqlite` in the process adapter,
 * Durable Object SQLite in the Cloudflare one), applies the migrations,
 * and passes the Drizzle database here. Each call checks the unit's signal
 * first, refuses a partition that does not parse and an operation it does
 * not hold, prepares every statement before it sends the first, and runs a
 * change, or a batch of changes, in one synchronous transaction: nothing
 * awaits between its statements, so no other unit's change lands between
 * them.
 *
 * What the platform throws becomes a failure
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)): a broken
 * constraint is `refused`, anything else the database throws (a closed or
 * busy database, a file it cannot read) is `unavailable`. The platforms
 * throw plain errors for these (`bun:sqlite` a `RangeError` for a closed
 * database), so whatever a call throws while it prepares or sends its
 * statements is the store's answer, never a defect, and its cause is kept.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { sql } from "../../shared/vendor/drizzle.mjs";
import { parsePartition } from "../core/partitions.ts";
import type {
  BatchResults,
  BatchStep,
  StorageFailureCode,
  StorageOperation,
  StoragePort,
} from "../core/storage.ts";
import type { UnitContext } from "../core/unit.ts";
import {
  type HubDatabase,
  IMPLEMENTATIONS,
  type Prepared,
  type PreparedStatement,
} from "./operations.ts";

/** One row of SQLite's query plan: what it does for one step of a statement. */
export interface PlanRow {
  readonly detail: string;
}

/** What the contract suite reads beside the port: each operation's query plans. */
export interface StorageInspection {
  /**
   * The query plan of each statement `op` prepares for `input` in
   * `partition`, in the order it sends them; nothing is sent but the
   * plans' own `EXPLAIN QUERY PLAN`.
   */
  explain(
    partition: string,
    op: StorageOperation<unknown, unknown>,
    input: unknown,
  ): Outcome<PlanRow[][], StorageFailureCode>;
  /** The names of the operations this storage holds. */
  readonly operations: readonly string[];
}

/** A failed storage outcome. */
type Failed = {
  ok: false;
  failure: { code: StorageFailureCode; reason: string; cause?: unknown };
};

/** The codes and messages along an error's chain of causes. */
function texts(thrown: unknown): string[] {
  const out: string[] = [];
  let at: unknown = thrown;
  for (let depth = 0; depth < 5 && at instanceof Error; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") out.push(code);
    out.push(at.message);
    at = at.cause;
  }
  return out;
}

/** What the database threw, as a failure. */
function failureOf(what: string, thrown: unknown): Failed {
  const said = texts(thrown);
  const reason = said.at(-1) ?? String(thrown);
  if (said.some((text) => /CONSTRAINT/i.test(text)))
    return failed("refused", `${what} broke a constraint: ${reason}`, thrown);
  return failed("unavailable", `${what} could not run: ${reason}`, thrown);
}

/** Why a call cannot start: the unit stopped, or a partition that does not parse. */
function cannotStart(context: UnitContext, partition: string): Failed | null {
  if (context.signal.aborted)
    return failed("aborted", `${context.unit} was stopped before storage ran`);
  const parsed = parsePartition(partition);
  return parsed.ok ? null : failed("refused", parsed.failure.reason);
}

/** Prepares `op` for `input`, or why it cannot be. */
function prepare(
  db: HubDatabase,
  partition: string,
  op: StorageOperation<unknown, unknown>,
  input: unknown,
): Outcome<Prepared<unknown>, StorageFailureCode> {
  const implementation = IMPLEMENTATIONS.get(op.name);
  if (implementation === undefined || implementation.op.kind !== op.kind)
    return failed(
      "refused",
      `storage holds no ${op.kind} operation named ${JSON.stringify(op.name)}`,
    );
  try {
    return implementation.prepare(db, partition, input);
  } catch (thrown) {
    return failureOf(`preparing ${op.name}`, thrown);
  }
}

/**
 * Runs `send` in one immediate transaction: SQLite takes the write lock
 * when the transaction starts, so two connections never both read before
 * either writes.
 */
function transact<T>(db: HubDatabase, send: () => T): T {
  return db.transaction(() => send(), { behavior: "immediate" });
}

/**
 * `statement`'s SQL with `EXPLAIN QUERY PLAN` before it, its parameters
 * bound again in order: Drizzle's SQLite dialect writes every parameter as
 * `?` and every value as a parameter, so no other `?` is in its text.
 */
function explainOf(statement: PreparedStatement) {
  const { sql: text, params } = statement.getQuery();
  const pieces = text.split("?");
  const chunks = [sql.raw(`EXPLAIN QUERY PLAN ${pieces[0] ?? ""}`)];
  params.forEach((param, index) => {
    chunks.push(sql`${param}`, sql.raw(pieces[index + 1] ?? ""));
  });
  return sql.join(chunks);
}

/** The storage port over `db`, and the inspection the contract suite reads. */
export function createStorage(
  db: HubDatabase,
): StoragePort & { readonly inspection: StorageInspection } {
  const run = async <Input, Result>(
    context: UnitContext,
    partition: string,
    op: StorageOperation<Input, Result>,
    input: Input,
  ): Promise<Outcome<Result, StorageFailureCode>> => {
    const stopped = cannotStart(context, partition);
    if (stopped !== null) return stopped;
    const prepared = prepare(
      db,
      partition,
      op as StorageOperation<unknown, unknown>,
      input,
    );
    if (!prepared.ok) return prepared;
    try {
      const result =
        op.kind === "change"
          ? transact(db, () => prepared.value.run())
          : prepared.value.run();
      return ok(result as Result);
    } catch (thrown) {
      return failureOf(op.name, thrown);
    }
  };

  const batch = async <
    const Steps extends readonly BatchStep<unknown, unknown>[],
  >(
    context: UnitContext,
    partition: string,
    steps: Steps,
  ): Promise<Outcome<BatchResults<Steps>, StorageFailureCode>> => {
    const stopped = cannotStart(context, partition);
    if (stopped !== null) return stopped;
    const prepared: Prepared<unknown>[] = [];
    for (const { op, input } of steps) {
      if (op.kind !== "change")
        return failed(
          "refused",
          `a batch holds changes only, and ${op.name} reads`,
        );
      const one = prepare(db, partition, op, input);
      if (!one.ok) return one;
      prepared.push(one.value);
    }
    try {
      const results = transact(db, () => prepared.map((p) => p.run()));
      return ok(results as BatchResults<Steps>);
    } catch (thrown) {
      return failureOf(
        `the batch of ${steps.map((s) => s.op.name).join(", ")}`,
        thrown,
      );
    }
  };

  const inspection: StorageInspection = {
    operations: [...IMPLEMENTATIONS.keys()],
    explain: (partition, op, input) => {
      const parsed = parsePartition(partition);
      if (!parsed.ok) return failed("refused", parsed.failure.reason);
      const prepared = prepare(db, partition, op, input);
      if (!prepared.ok) return prepared;
      try {
        return ok(
          prepared.value.statements.map((statement) =>
            db.all<PlanRow>(explainOf(statement)),
          ),
        );
      } catch (thrown) {
        return failureOf(`explaining ${op.name}`, thrown);
      }
    },
  };

  return { run, batch, inspection };
}
