/** Hourly outbound call totals in the existing budget database; recording never stops a call. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { launchOf } from "../launched-session.ts";
import { swallow } from "../errors.ts";
import { inTransaction, openDatabase, openReadOnly } from "../records/db.ts";
import { budgetPath, parseRecord, type BudgetRecord } from "./budget.ts";
import type { FailureClass } from "./failure.ts";
import { BUDGET_MIGRATIONS } from "./schema.ts";

const LEDGER_RETENTION_MS = 7 * 24 * 3_600_000;
const HOUR = 3_600_000;
export interface CallRecord {
  system: string;
  credential: string;
  operation: string;
  caller?: string;
  requests?: number;
  cost?: number | null;
  unit?: string;
  estimated?: boolean;
  durationMs: number;
  failure?: FailureClass | null;
  at?: number;
  path?: string;
}
export interface LedgerRow {
  hour: number;
  system: string;
  credential: string;
  operation: string;
  caller: string;
  unit: string;
  requests: number;
  cost: number;
  unknownCost: number;
  estimated: number;
  durationMs: number;
  failures: Partial<Record<FailureClass, number>>;
}
export interface LedgerReport {
  rows: LedgerRow[];
  balances: { key: string; system: string; record: BudgetRecord }[];
  unavailable?: boolean;
}
interface Context {
  caller?: string;
  path?: string;
  writer?: (record: CallRecord) => void;
}
const context = new AsyncLocalStorage<Context>();
// A harness may provide fixture storage before loading any installed plugin
// copy. The global symbol makes that dependency common to copies in one realm.
const defaultPathKey = Symbol.for("jig.outbound-ledger.default-path");
const dependencies = globalThis as typeof globalThis & {
  [defaultPathKey]?: string;
};
/** Supply default storage without changing the home directory; null restores machine storage. */
export function setDefaultLedgerPath(path: string | null): void {
  if (path === null) delete dependencies[defaultPathKey];
  else dependencies[defaultPathKey] = path;
}
function defaultLedgerPath(): string {
  return dependencies[defaultPathKey] ?? budgetPath();
}

/** Attribute concurrent calls to one run without changing process-wide state. */
export function withCaller<T>(caller: string, fn: () => T): T {
  return context.run({ ...context.getStore(), caller }, fn);
}
/** An isolated database for a caller's tests, inherited by asynchronous sends. */
export function withLedgerPath<T>(path: string, fn: () => T): T {
  return context.run({ ...context.getStore(), path }, fn);
}
/** An isolated writer for transport tests; the normal writer remains best effort. */
export function withLedgerWriter<T>(
  writer: (record: CallRecord) => void,
  fn: () => T,
): T {
  return context.run({ ...context.getStore(), writer }, fn);
}
/** The caller inherited by child processes, otherwise the skill command a person ran. */
function currentCaller(): string {
  return (
    context.getStore()?.caller ??
    process.env.JIG_OUTBOUND_CALLER ??
    (launchOf()
      ? `pass:${launchOf()}`
      : `skill:${basename(process.argv[1] ?? "jig")}`)
  );
}
/** The caller to preserve when this process starts an outbound-capable child. */
export function callerForChild(): string {
  return currentCaller();
}
/** Named GraphQL operation, or a stable opaque name for an anonymous document. */
export function operationName(query: string): string {
  const clean = query.replace(/^\s*#.*$/gm, "");
  const named =
    /^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      clean,
    )?.[1];
  if (named) return named;
  const hash = createHash("sha256").update(query).digest("hex").slice(0, 12);
  // Strip strings before looking for the selection, so an argument's text
  // cannot become the operation name. Keep the root field, never its values.
  const shape = clean.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const field =
    /\{\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)/.exec(
      shape,
    )?.[1];
  const kind = /^\s*mutation\b/.test(shape) ? "mutation" : "query";
  return field ? `${kind}:${field}-${hash}` : `anonymous-${hash}`;
}
function positive(n: number | undefined, fallback = 0): number {
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
}
/** Record one actual attempt (or a local refusal with zero requests), retaining no payload or secret. */
export function recordCall(input: CallRecord): void {
  try {
    const caller = input.caller ?? currentCaller();
    const writer = context.getStore()?.writer;
    if (writer) {
      writer({ ...input, caller });
      return;
    }
    const path = input.path ?? context.getStore()?.path ?? defaultLedgerPath();
    const opened = openDatabase({
      path,
      migrations: BUDGET_MIGRATIONS,
      busyMs: 0,
    });
    if (!opened.ok) {
      swallow(opened.failure, "the outbound cost ledger");
      return;
    }
    const db = opened.value;
    const at = input.at ?? Date.now();
    const hour = Math.floor(at / HOUR) * HOUR;
    const unit = input.unit ?? "requests";
    const requests = positive(input.requests, 1);
    const cost = input.cost == null ? 0 : positive(input.cost);
    const unknown = input.cost == null && requests > 0 ? 1 : 0;
    const estimated = input.estimated ? 1 : 0;
    const duration = positive(input.durationMs);
    const keys = [
      hour,
      input.system,
      input.credential,
      input.operation,
      caller,
      unit,
    ];
    // Accounting is best effort: a busy ledger must never extend an outbound
    // call beyond its own deadline. Restore the connection's normal policy
    // after this one nonblocking write for its other users.
    db.run("PRAGMA busy_timeout = 0");
    try {
      inTransaction(db, () => {
        db.query("DELETE FROM outbound_cost WHERE hour < ?").run(
          Math.ceil((at - LEDGER_RETENTION_MS) / HOUR) * HOUR,
        );
        const prior = db
          .query(
            "SELECT * FROM outbound_cost WHERE hour=? AND system=? AND credential=? AND operation=? AND caller=? AND unit=?",
          )
          .get(...keys) as RawRow | null;
        const failures: Partial<Record<FailureClass, number>> = prior
          ? JSON.parse(prior.failures)
          : {};
        if (input.failure)
          failures[input.failure] = (failures[input.failure] ?? 0) + 1;
        db.query(
          "INSERT OR REPLACE INTO outbound_cost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          ...keys,
          (prior?.requests ?? 0) + requests,
          (prior?.cost ?? 0) + cost,
          (prior?.unknown_cost ?? 0) + unknown,
          (prior?.estimated ?? 0) + estimated,
          (prior?.duration_ms ?? 0) + duration,
          JSON.stringify(failures),
        );
      });
    } finally {
      db.run("PRAGMA busy_timeout = 10000");
    }
  } catch (error) {
    swallow(error, "write the outbound cost ledger");
  }
}
interface RawRow {
  hour: number;
  system: string;
  credential: string;
  operation: string;
  caller: string;
  unit: string;
  requests: number;
  cost: number;
  unknown_cost: number;
  estimated: number;
  duration_ms: number;
  failures: string;
}
/** Read without creating or migrating a database; absent storage is an empty report. */
export function ledgerReport(
  opts: { since?: number; until?: number; caller?: string; path?: string } = {},
): LedgerReport {
  const path = opts.path ?? context.getStore()?.path ?? defaultLedgerPath();
  const opened = openReadOnly({ path, migrations: BUDGET_MIGRATIONS });
  if (!opened.ok) {
    swallow(opened.failure, "read the outbound cost ledger");
    return { rows: [], balances: [], unavailable: true };
  }
  if (opened.value === null) return { rows: [], balances: [] };
  const db = opened.value.db;
  try {
    const until = opts.until ?? Date.now();
    const since = Math.max(
      opts.since ?? until - 24 * HOUR,
      until - LEDGER_RETENTION_MS,
    );
    const hasLedger =
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbound_cost'",
        )
        .get() !== null;
    const rows = hasLedger
      ? (db
          .query(
            "SELECT * FROM outbound_cost WHERE hour >= ? AND hour <= ? ORDER BY hour,system,operation,caller",
          )
          .all(
            Math.floor(since / HOUR) * HOUR,
            Math.floor(until / HOUR) * HOUR,
          ) as RawRow[])
      : [];
    const balances = (
      db.query("SELECT key,value FROM tracker_budget").all() as {
        key: string;
        value: string;
      }[]
    ).flatMap((r) => {
      const record = parseRecord(r.value);
      return record === null
        ? []
        : [{ key: r.key, system: r.key.split(":")[0] ?? r.key, record }];
    });
    return {
      rows: rows
        .filter((r) => opts.caller === undefined || r.caller === opts.caller)
        .map(({ unknown_cost, duration_ms, failures, ...row }) => ({
          ...row,
          unknownCost: unknown_cost,
          durationMs: duration_ms,
          failures: JSON.parse(failures),
        })),
      balances,
    };
  } catch (error) {
    swallow(error, "read the outbound cost ledger");
    return { rows: [], balances: [], unavailable: true };
  } finally {
    db.close();
  }
}
