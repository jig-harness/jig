/** Hourly outbound call totals in the existing budget database; recording never stops a call. */
import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { launchOf } from "../launched-session.ts";
import { swallow } from "../errors.ts";
import { inTransaction, openDatabase, openReadOnly } from "../records/db.ts";
import { currentMs } from "../time.ts";
import { budgetPath, parseRecord, type BudgetRecord } from "./budget.ts";
import type { FailureClass } from "./failure.ts";
import { queryOperation } from "./operations.ts";
import { BUDGET_MIGRATIONS } from "./schema.ts";

const LEDGER_RETENTION_MS = 7 * 24 * 3_600_000;
/**
 * The operation and caller of the row that holds spending no counted call
 * explains: what a balance the system reported shows was spent beyond what
 * the record had counted. No operation or caller name takes this form.
 */
export const UNATTRIBUTED = "(unattributed)";
const HOUR = 3_600_000;
export interface CallRecord {
  system: string;
  credential: string;
  /** The quota owner's record key, where the system keeps one apart from the credential (GitHub). */
  owner?: string | null;
  /** The window of the owner's record spent: `requests`, `complexity`, `search`, `none` or `unknown`. */
  window?: string | null;
  operation: string;
  caller?: string;
  /** The repository the call addressed, `owner/name` lowercased, where the transport knows it; absent or `null` for a call on no known repository. */
  repository?: string | null;
  requests?: number;
  /** Of `requests`, how many a conditional request had answered `304 Not Modified`. */
  notModified?: number;
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
  /** Of `requests`, how many a conditional request had answered `304 Not Modified`; 0 for a row written without the count. */
  notModified?: number;
  cost: number;
  unknownCost: number;
  estimated: number;
  durationMs: number;
  failures: Partial<Record<FailureClass, number>>;
  /**
   * The quota owner's record the row's calls spent: as recorded, else the
   * owner the machine knows for the credential; `null` when neither names
   * one (the credential's own record).
   */
  owner?: string | null;
  /** The window of that record they spent, as recorded; `null` for a row written without one, whose window a reader infers. */
  window?: string | null;
  /**
   * The parts of the row's spending each known repository took, as
   * recorded; what the row holds beyond them was spent on no known
   * repository. Empty for a row written without one, or read from a
   * database that keeps none.
   */
  repositories?: RepositoryPart[];
}
/** The part of a ledger row's spending one repository took. */
export interface RepositoryPart {
  repository: string;
  requests: number;
  cost: number;
  unknownCost: number;
  notModified: number;
}
export interface LedgerReport {
  rows: LedgerRow[];
  balances: { key: string; system: string; record: BudgetRecord }[];
  unavailable?: boolean;
}
interface Context {
  operation?: string;
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
/** The budget database this process writes: the machine's, or the storage a harness supplied. */
export function defaultLedgerPath(): string {
  return dependencies[defaultPathKey] ?? budgetPath();
}

/** Attribute concurrent calls to one run without changing process-wide state. */
export function withCaller<T>(caller: string, fn: () => T): T {
  return context.run({ ...context.getStore(), caller }, fn);
}
/** Attribute a compound tracker operation while retaining every actual call's cost. */
export function withOperation<T>(operation: string, fn: () => T): T {
  return context.run({ ...context.getStore(), operation }, fn);
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
  return queryOperation(query, (text) =>
    createHash("sha256").update(text).digest("hex").slice(0, 12),
  );
}
function positive(n: number | undefined, fallback = 0): number {
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
}
/**
 * The row's quota owner and window sit beside it, in a table of their own, so
 * a copy that writes the row's columns by position still can.
 */
function writeQuota(
  db: Database,
  keys: (string | number)[],
  input: CallRecord,
  cutoff: number,
): void {
  db.query("DELETE FROM outbound_cost_quota WHERE hour < ?").run(cutoff);
  if (input.owner == null && input.window == null) return;
  db.query(
    "INSERT OR REPLACE INTO outbound_cost_quota VALUES (?,?,?,?,?,?,?,?)",
  ).run(...keys, input.owner ?? null, input.window ?? null);
}
/** Add an attempt's `304 Not Modified` answers to its row's count, kept beside the row like its quota. */
function writeNotModified(
  db: Database,
  keys: (string | number)[],
  input: CallRecord,
  cutoff: number,
): void {
  db.query("DELETE FROM outbound_cost_not_modified WHERE hour < ?").run(cutoff);
  const count = positive(input.notModified);
  if (count === 0) return;
  db.query(
    "INSERT INTO outbound_cost_not_modified VALUES (?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET not_modified = not_modified + excluded.not_modified",
  ).run(...keys, count);
}
/** Add an attempt to its repository's part of its row, kept beside the row like its quota; an attempt on no known repository adds to none. */
function writeRepository(
  db: Database,
  keys: (string | number)[],
  input: CallRecord,
  part: Omit<RepositoryPart, "repository">,
  cutoff: number,
): void {
  db.query("DELETE FROM outbound_cost_repository WHERE hour < ?").run(cutoff);
  const repository = input.repository?.trim().toLowerCase() ?? "";
  if (repository === "") return;
  db.query(
    "INSERT INTO outbound_cost_repository VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET requests = requests + excluded.requests, cost = cost + excluded.cost, unknown_cost = unknown_cost + excluded.unknown_cost, not_modified = not_modified + excluded.not_modified",
  ).run(
    ...keys,
    repository,
    part.requests,
    part.cost,
    part.unknownCost,
    part.notModified,
  );
}
/** Record one actual attempt (or a local refusal with zero requests), retaining no payload or secret. */
export function recordCall(input: CallRecord): void {
  const operation = context.getStore()?.operation;
  if (operation !== undefined) input = { ...input, operation };
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
    const at = input.at ?? currentMs();
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
        const cutoff = Math.ceil((at - LEDGER_RETENTION_MS) / HOUR) * HOUR;
        writeQuota(db, keys, input, cutoff);
        writeNotModified(db, keys, input, cutoff);
        writeRepository(
          db,
          keys,
          input,
          {
            requests,
            cost,
            unknownCost: unknown,
            notModified: positive(input.notModified),
          },
          cutoff,
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
  owner?: string | null;
  quota_window?: string | null;
  not_modified?: number | null;
}
/** The key of a row: its hour, system, credential, operation, caller and unit. */
type RowKeys = Pick<
  RawRow,
  "hour" | "system" | "credential" | "operation" | "caller" | "unit"
>;
function rowKey(row: RowKeys): string {
  return JSON.stringify([
    row.hour,
    row.system,
    row.credential,
    row.operation,
    row.caller,
    row.unit,
  ]);
}
/** The repositories' parts of the rows from `from` to `to`, by row key; none from a database that keeps none (`db` null). */
function repositoryParts(
  db: Database | null,
  from: number,
  to: number,
): Map<string, RepositoryPart[]> {
  const parts = new Map<string, RepositoryPart[]>();
  if (db === null) return parts;
  const rows = db
    .query(
      "SELECT * FROM outbound_cost_repository WHERE hour >= ? AND hour <= ? ORDER BY repository",
    )
    .all(from, to) as (RowKeys & {
    repository: string;
    requests: number;
    cost: number;
    unknown_cost: number;
    not_modified: number;
  })[];
  for (const row of rows) {
    const key = rowKey(row);
    const part: RepositoryPart = {
      repository: row.repository,
      requests: row.requests,
      cost: row.cost,
      unknownCost: row.unknown_cost,
      notModified: row.not_modified,
    };
    const kept = parts.get(key);
    if (kept === undefined) parts.set(key, [part]);
    else kept.push(part);
  }
  return parts;
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
    const until = opts.until ?? currentMs();
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
    const has = (table: string) =>
      db
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) !== null;
    // A database an earlier copy created has no quota table, nor a count of
    // not-modified answers: its rows name no owner or window, which a reader
    // infers, and count no 304 answers.
    const beside = (table: string, alias: string) =>
      has(table)
        ? ` LEFT JOIN ${table} ${alias} ON ${alias}.hour=c.hour AND ${alias}.system=c.system AND ${alias}.credential=c.credential AND ${alias}.operation=c.operation AND ${alias}.caller=c.caller AND ${alias}.unit=c.unit`
        : "";
    const quotaJoin = beside("outbound_cost_quota", "q");
    const notModifiedJoin = beside("outbound_cost_not_modified", "n");
    const quota = `SELECT c.*, ${
      quotaJoin === ""
        ? "NULL AS owner, NULL AS quota_window"
        : "q.owner AS owner, q.quota_window AS quota_window"
    }, ${
      notModifiedJoin === "" ? "NULL" : "n.not_modified"
    } AS not_modified FROM outbound_cost c${quotaJoin}${notModifiedJoin}`;
    const rows = hasLedger
      ? (db
          .query(
            `${quota} WHERE c.hour >= ? AND c.hour <= ? ORDER BY c.hour,c.system,c.operation,c.caller`,
          )
          .all(
            Math.floor(since / HOUR) * HOUR,
            Math.floor(until / HOUR) * HOUR,
          ) as RawRow[])
      : [];
    const parts = repositoryParts(
      has("outbound_cost_repository") ? db : null,
      Math.floor(since / HOUR) * HOUR,
      Math.floor(until / HOUR) * HOUR,
    );
    // The owners the machine knows for credentials, for rows that name none.
    const owners = new Map(
      has("github_owner")
        ? (
            db
              .query(
                "SELECT credential, owner FROM github_owner WHERE credential IN (SELECT value FROM json_each(?))",
              )
              .all(
                JSON.stringify([...new Set(rows.map((r) => r.credential))]),
              ) as {
              credential: string;
              owner: string;
            }[]
          ).map((r) => [r.credential, r.owner])
        : [],
    );
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
        .map(
          ({
            unknown_cost,
            duration_ms,
            failures,
            owner,
            quota_window,
            not_modified,
            ...row
          }) => ({
            ...row,
            notModified: not_modified ?? 0,
            unknownCost: unknown_cost,
            durationMs: duration_ms,
            failures: JSON.parse(failures),
            owner: owner ?? owners.get(row.credential) ?? null,
            window: quota_window ?? null,
            repositories: parts.get(rowKey(row)) ?? [],
          }),
        ),
      balances,
    };
  } catch (error) {
    swallow(error, "read the outbound cost ledger");
    return { rows: [], balances: [], unavailable: true };
  } finally {
    db.close();
  }
}
