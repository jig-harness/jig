/**
 * A tracker credential's request budget, one record per credential that every
 * process on the machine shares: the dispatcher's ticks, the pickup and
 * follow-up passes it starts, and the skills a person runs.
 *
 * A tracker's transport asks the budget before each request (`admit`, which also reserves that request's part of the request count; a query's complexity is known only from its answer) and
 * tells it what each answer said of the limits (`observe`). While the
 * tracker has refused the credential (its rate limit is spent), no request
 * leaves the machine until the reset the answer named: `admit` throws a
 * `TrackerRateLimited` at once, naming the reset, so a caller waits rather
 * than sends a request the tracker would refuse again. A process that runs
 * the dispatcher's reads (`setDispatcherShare`) also stops at its share of
 * each window, leaving the rest of the budget to passes and people.
 *
 * The record lives in a small SQLite database under the Jig state directory
 * (`~/.local/state/jig/tracker/budget.sqlite`, table `tracker_budget`),
 * keyed by the adapter and a hash of the credential, never the credential
 * itself. A store that cannot be opened or written governs nothing: the
 * request goes out as it would without a budget, since a broken store must
 * not stop every tracker read on the machine.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { swallow } from "./errors.ts";
import { JigError } from "./outcome.ts";
import { inTransaction, type Migration, openDatabase } from "./records/db.ts";

/** How long a credential stays limited when the refusal named no reset. */
export const FALLBACK_LIMIT_MS = 15 * 60_000;

/** The share of each window the dispatcher's reads may use when the machine file names none. */
export const DEFAULT_DISPATCHER_SHARE = 0.5;

/** One of a tracker's limits as its last answer reported it; `null` where it did not say. */
export interface BudgetWindow {
  limit: number | null;
  remaining: number | null;
  /** When the window resets, epoch milliseconds. */
  resetAt: number | null;
}

/** What the machine knows of one credential's budget. */
export interface BudgetRecord {
  /** The request count (Linear's `X-RateLimit-Requests-*`). */
  requests: BudgetWindow;
  /** The query complexity (Linear's `X-RateLimit-Complexity-*`). */
  complexity: BudgetWindow;
  /** Until when the tracker refuses the credential, epoch milliseconds; `null` when it does not. */
  limitedUntil: number | null;
  /** What the refusal said. */
  why: string | null;
  /** When an answer last updated the record. */
  observedAt: number;
}

/** What one answer said: the windows it reported, and whether it refused the credential and until when. */
export interface BudgetAnswer {
  requests?: BudgetWindow;
  complexity?: BudgetWindow;
  limitedUntil?: number;
  why?: string;
}

/** No request may leave for the credential before `resetAt`. */
export class TrackerRateLimited extends JigError<"tracker-rate-limited"> {
  override name = "TrackerRateLimited";
  /** Epoch milliseconds. */
  readonly resetAt: number;
  /** The adapter, for messages. */
  readonly adapter: string;
  constructor(adapter: string, resetAt: number, reason: string) {
    super(
      "tracker-rate-limited",
      `${adapter}'s rate limit for this credential is spent until ${new Date(resetAt).toISOString()}: ${reason}`,
    );
    this.resetAt = resetAt;
    this.adapter = adapter;
  }
}

/** Whether `error` is a rate-limited refusal, from this module or a copy of it another release loaded. */
export function isRateLimited(error: unknown): error is TrackerRateLimited {
  return (
    error instanceof TrackerRateLimited ||
    (error instanceof Error &&
      (error as { code?: unknown }).code === "tracker-rate-limited" &&
      typeof (error as { resetAt?: unknown }).resetAt === "number")
  );
}

/** The key a credential's record is kept under: the adapter and a hash of the secret, never the secret. */
export function credentialKey(adapter: string, secret: string): string {
  const hash = createHash("sha256").update(secret).digest("hex").slice(0, 16);
  return `${adapter}:${hash}`;
}

/** Where the records are kept. */
export interface BudgetStore {
  read(key: string): BudgetRecord | null;
  /**
   * Apply `change` to the record in one transaction, so two processes' answers
   * do not lose one another; a `null` result leaves the record as it was.
   */
  update(
    key: string,
    change: (prev: BudgetRecord | null) => BudgetRecord | null,
  ): void;
}

/** A store held in this process only, for tests. */
export function memoryBudgetStore(): BudgetStore {
  const rows = new Map<string, BudgetRecord>();
  return {
    read: (key) => rows.get(key) ?? null,
    update(key, change) {
      const next = change(rows.get(key) ?? null);
      if (next !== null) rows.set(key, next);
    },
  };
}

const MIGRATIONS: readonly Migration[] = [
  {
    additive: false,
    sql: "CREATE TABLE tracker_budget (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  },
];

/** The machine's budget database: `~/.local/state/jig/tracker/budget.sqlite`. */
export function budgetPath(home = homedir()): string {
  return join(home, ".local", "state", "jig", "tracker", "budget.sqlite");
}

const orNull = (v: unknown, ok: (n: number) => boolean): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v) && ok(v));

function validWindow(w: unknown): w is BudgetWindow {
  if (typeof w !== "object" || w === null) return false;
  const { limit, remaining, resetAt } = w as Record<string, unknown>;
  return (
    orNull(limit, (n) => n >= 0) &&
    orNull(remaining, () => true) &&
    orNull(resetAt, (n) => n >= 0)
  );
}

/** A record read from the store only when every field has its shape; a damaged one reads as none. */
function validRecord(value: unknown): value is BudgetRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    validWindow(r.requests) &&
    validWindow(r.complexity) &&
    orNull(r.limitedUntil, (n) => n >= 0) &&
    (r.why === null || typeof r.why === "string") &&
    typeof r.observedAt === "number" &&
    Number.isFinite(r.observedAt)
  );
}

function parseRecord(text: string): BudgetRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    return validRecord(value) ? value : null;
  } catch (error) {
    swallow(error, "a tracker budget record does not read");
    return null;
  }
}

/** The SQLite store at `path`; one that cannot be opened governs nothing. */
export function sqliteBudgetStore(path = budgetPath()): BudgetStore {
  let db: Database | null | undefined;
  const open = (): Database | null => {
    if (db !== undefined) return db;
    const opened = openDatabase({ path, migrations: MIGRATIONS });
    if (!opened.ok) swallow(opened.failure, "the tracker budget store");
    db = opened.ok ? opened.value : null;
    return db;
  };
  const get = (d: Database, key: string): BudgetRecord | null => {
    const row = d
      .query("SELECT value FROM tracker_budget WHERE key = ?")
      .get(key) as { value: string } | null;
    return row === null ? null : parseRecord(row.value);
  };
  return {
    read(key) {
      try {
        const d = open();
        return d === null ? null : get(d, key);
      } catch (error) {
        swallow(error, "read the tracker budget");
        return null;
      }
    },
    update(key, change) {
      try {
        const d = open();
        if (d === null) return;
        inTransaction(d, () => {
          const next = change(get(d, key));
          if (next === null) return;
          d.query(
            "INSERT OR REPLACE INTO tracker_budget (key, value) VALUES (?, ?)",
          ).run(key, JSON.stringify(next));
        });
      } catch (error) {
        swallow(error, "write the tracker budget");
      }
    },
  };
}

let dispatcherShare: number | null = null;

/**
 * Make this process's requests the dispatcher's: each window is used only
 * down to `1 - share` of its limit. `null` lifts the cap (a pass or a
 * person's skill uses the whole budget).
 */
export function setDispatcherShare(share: number | null): void {
  dispatcherShare = share;
}

/** The share this process's requests may use; `null` for all of it. */
function currentShare(): number | null {
  return dispatcherShare;
}

/** Admits requests for a credential and records what the answers said. */
export interface BudgetGovernor {
  /** Throws `TrackerRateLimited` when no request may leave now. */
  admit(adapter: string, key: string): void;
  /** Record what one answer said; returns the record as it now stands. */
  observe(key: string, answer: BudgetAnswer): void;
}

const EMPTY: BudgetWindow = { limit: null, remaining: null, resetAt: null };

/**
 * The newer of two readings of a window: the lower count within the same
 * window, the stored reading when the answer is from an older window (a
 * delayed response across a reset), else the answer.
 */
function merged(
  prev: BudgetWindow,
  next: BudgetWindow | undefined,
): BudgetWindow {
  if (next === undefined) return prev;
  if (
    prev.resetAt !== null &&
    next.resetAt === prev.resetAt &&
    prev.remaining !== null &&
    next.remaining !== null
  )
    return { ...next, remaining: Math.min(prev.remaining, next.remaining) };
  if (
    prev.resetAt !== null &&
    next.resetAt !== null &&
    next.resetAt < prev.resetAt
  )
    return prev;
  return next;
}

/** The window that stops the dispatcher, if one does: spent, or at its share. */
function spentWindow(
  record: BudgetRecord,
  share: number | null,
  now: number,
): { resetAt: number; why: string } | null {
  for (const [name, w] of [
    ["requests", record.requests],
    ["complexity", record.complexity],
  ] as const) {
    if (w.remaining === null || w.resetAt === null || w.resetAt <= now)
      continue;
    if (w.remaining <= 0)
      return { resetAt: w.resetAt, why: `no ${name} left in the window` };
    if (
      share !== null &&
      w.limit !== null &&
      w.remaining <= w.limit * (1 - share)
    )
      return {
        resetAt: w.resetAt,
        why: `the dispatcher's share (${Math.round(share * 100)}%) of the ${name} window is spent; ${w.remaining} of ${w.limit} are left to passes and people`,
      };
  }
  return null;
}

/** A governor over `store`; `clock` and `share` are for tests. */
export function budgetGovernor(
  store: BudgetStore,
  opts: { clock?: () => number; share?: () => number | null } = {},
): BudgetGovernor {
  const clock = opts.clock ?? Date.now;
  const share = opts.share ?? currentShare;
  return {
    admit(adapter, key) {
      const now = clock();
      const out: { refusal: TrackerRateLimited | null } = { refusal: null };
      // The decision and the reservation of one request are one transaction,
      // so concurrent callers each spend their own part of the balance.
      store.update(key, (record) => {
        if (record === null) return null;
        if (record.limitedUntil !== null && record.limitedUntil > now) {
          out.refusal = new TrackerRateLimited(
            adapter,
            record.limitedUntil,
            record.why ?? "the tracker refused it",
          );
          return null;
        }
        const spent = spentWindow(record, share(), now);
        if (spent !== null) {
          out.refusal = new TrackerRateLimited(
            adapter,
            spent.resetAt,
            spent.why,
          );
          return null;
        }
        const w = record.requests;
        if (w.remaining === null || w.resetAt === null || w.resetAt <= now)
          return null;
        return {
          ...record,
          requests: { ...w, remaining: w.remaining - 1 },
        };
      });
      if (out.refusal !== null) throw out.refusal;
    },
    observe(key, answer) {
      const now = clock();
      store.update(key, (prev) => {
        const base: BudgetRecord = prev ?? {
          requests: EMPTY,
          complexity: EMPTY,
          limitedUntil: null,
          why: null,
          observedAt: now,
        };
        const stillLimited =
          base.limitedUntil !== null && base.limitedUntil > now;
        return {
          requests: merged(base.requests, answer.requests),
          complexity: merged(base.complexity, answer.complexity),
          limitedUntil:
            answer.limitedUntil !== undefined
              ? Math.max(
                  answer.limitedUntil,
                  stillLimited ? (base.limitedUntil as number) : 0,
                )
              : stillLimited
                ? base.limitedUntil
                : null,
          why: answer.why ?? (stillLimited ? base.why : null),
          observedAt: now,
        };
      });
    },
  };
}

let machineGovernor: BudgetGovernor | undefined;

/** The machine's governor, over the store in the Jig state directory. */
export function defaultGovernor(): BudgetGovernor {
  machineGovernor ??= budgetGovernor(sqliteBudgetStore());
  return machineGovernor;
}
