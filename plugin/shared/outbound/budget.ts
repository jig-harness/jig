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
import { swallow } from "../errors.ts";
import { JigError } from "../outcome.ts";
import { inTransaction, openDatabase } from "../records/db.ts";

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
  /**
   * How long the tracker takes to refill an empty window, when it refills
   * continuously (Linear's leaky bucket) rather than all at once at the
   * reset; absent for a window that resets whole.
   */
  refillMs?: number | null;
  /**
   * When `remaining` was read or reserved, epoch milliseconds: what a
   * refilling window has refilled counts from it. Absent: the record's
   * `observedAt`.
   */
  readAt?: number | null;
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

import { BUDGET_MIGRATIONS } from "./schema.ts";

/** The machine's budget database: `~/.local/state/jig/tracker/budget.sqlite`. */
export function budgetPath(home = homedir()): string {
  return join(home, ".local", "state", "jig", "tracker", "budget.sqlite");
}

const orNull = (v: unknown, ok: (n: number) => boolean): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v) && ok(v));

function validWindow(w: unknown): w is BudgetWindow {
  if (typeof w !== "object" || w === null) return false;
  const { limit, remaining, resetAt, refillMs, readAt } = w as Record<
    string,
    unknown
  >;
  return (
    orNull(limit, (n) => n >= 0) &&
    orNull(remaining, () => true) &&
    orNull(resetAt, (n) => n >= 0) &&
    (refillMs === undefined || orNull(refillMs, (n) => n > 0)) &&
    (readAt === undefined || orNull(readAt, (n) => n >= 0))
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

export function parseRecord(text: string): BudgetRecord | null {
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
    const opened = openDatabase({ path, migrations: BUDGET_MIGRATIONS });
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
  /** Throws `TrackerRateLimited` when no request may leave now; returns the time the request was admitted. */
  admit(adapter: string, key: string): number;
  /**
   * Record what one answer said. `sentAt` is the `admit` time of the request
   * it answers: what was recorded since is not in the answer.
   */
  observe(key: string, answer: BudgetAnswer, sentAt?: number): void;
}

const EMPTY: BudgetWindow = { limit: null, remaining: null, resetAt: null };

/**
 * The newer of two readings of a window, the answer read at `now`: the
 * lower count within the same window that resets whole, the stored reading
 * (with its own read time) when the answer is from an older window (a
 * delayed response across a reset) or says nothing of this window, else the
 * answer. A window that refills continuously compares counts only at one
 * time: an answer to a request sent at `sentAt` leaves out every reservation
 * and reading recorded since (`readAt` at or after `sentAt`), however long
 * the request was in flight, so it takes the lower of the answer and the
 * stored balance carried to `now` (reservations included); an answer with
 * nothing recorded since its request was sent is the newest.
 */
function merged(
  prev: BudgetWindow,
  next: BudgetWindow | undefined,
  now: number,
  sentAt: number | undefined,
): BudgetWindow {
  if (next === undefined) return prev;
  const read = { ...next, readAt: now };
  const count = next.remaining;
  if (count === null) return olderWindow(prev, next) ? prev : read;
  if (sameResetWindow(prev, next) && prev.remaining !== null)
    return { ...read, remaining: Math.min(prev.remaining, count) };
  if (olderWindow(prev, next)) return prev;
  const carried = carriedBalance(prev, next, now, sentAt);
  return carried === null
    ? read
    : { ...read, remaining: Math.min(carried, count) };
}

/** Both readings are of one window that resets whole, with counts. */
function sameResetWindow(prev: BudgetWindow, next: BudgetWindow): boolean {
  return (
    next.refillMs == null &&
    prev.resetAt !== null &&
    next.resetAt === prev.resetAt &&
    prev.remaining !== null &&
    next.remaining !== null
  );
}

/** The answer is from a window that ended before the stored one. */
function olderWindow(prev: BudgetWindow, next: BudgetWindow): boolean {
  return (
    prev.resetAt !== null &&
    next.resetAt !== null &&
    next.resetAt < prev.resetAt
  );
}

/**
 * The stored balance of a continuously refilling window carried to `now`,
 * when the stored reading was recorded at or after the answer's request was
 * sent and so is not in the answer; else null.
 */
function carriedBalance(
  prev: BudgetWindow,
  next: BudgetWindow,
  now: number,
  sentAt: number | undefined,
): number | null {
  if (
    next.refillMs == null ||
    prev.refillMs == null ||
    prev.readAt == null ||
    sentAt === undefined ||
    prev.readAt < sentAt ||
    next.remaining === null
  )
    return null;
  return holds(prev, prev.readAt, now);
}

/**
 * What a window holds at `now`: its last reading, and for a window that
 * refills continuously, what has refilled since that reading (`readAt`, else
 * the record's `observedAt`), up to its limit.
 */
function holds(
  w: BudgetWindow,
  observedAt: number,
  now: number,
): number | null {
  if (w.remaining === null) return null;
  if (w.refillMs == null || w.limit === null) return w.remaining;
  const refilled = ((now - (w.readAt ?? observedAt)) * w.limit) / w.refillMs;
  return Math.min(w.limit, w.remaining + refilled);
}

/**
 * When a window next holds more than `floor`: its reset, or for a window
 * that refills continuously, when the refill gets it past the floor (the
 * reset a tracker names for such a window is a full refill away).
 */
function usableAt(
  w: BudgetWindow & { resetAt: number },
  held: number,
  floor: number,
  now: number,
): number {
  if (w.refillMs == null || w.limit === null || w.limit <= 0) return w.resetAt;
  const wait = ((floor + 1 - held) * w.refillMs) / w.limit;
  return Math.min(w.resetAt, now + Math.ceil(wait) + 1000);
}

/**
 * The window that stops the dispatcher, if one does: spent, or at its share.
 * With several blocked, the one that recovers last, since admission waits for
 * all of them.
 */
function spentWindow(
  record: BudgetRecord,
  share: number | null,
  now: number,
): { resetAt: number; why: string } | null {
  let binding: { resetAt: number; why: string } | null = null;
  for (const [name, w] of [
    ["requests", record.requests],
    ["complexity", record.complexity],
  ] as const) {
    const blocked = blockedWindow(name, w, record.observedAt, share, now);
    if (
      blocked !== null &&
      (binding === null || binding.resetAt < blocked.resetAt)
    )
      binding = blocked;
  }
  return binding;
}

/** Whether one window stops the dispatcher, and until when. */
function blockedWindow(
  name: string,
  w: BudgetWindow,
  observedAt: number,
  share: number | null,
  now: number,
): { resetAt: number; why: string } | null {
  const held = holds(w, observedAt, now);
  if (held === null || w.resetAt === null || w.resetAt <= now) return null;
  // What the window must hold again: more than the part of it kept for
  // passes and people, and for requests one whole request (a refilling
  // balance is fractional).
  const floor = share !== null && w.limit !== null ? w.limit * (1 - share) : 0;
  const unit = name === "requests" ? 1 : 0;
  const empty = unit > 0 ? held < unit : held <= 0;
  if (held > floor && !empty) return null;
  return {
    resetAt: usableAt({ ...w, resetAt: w.resetAt }, held, floor, now),
    why: empty
      ? `no ${name} left in the window`
      : `the dispatcher's share (${Math.round((share ?? 0) * 100)}%) of the ${name} window is spent; ${Math.floor(held)} of ${w.limit} are left to passes and people`,
  };
}

/** Why a request is refused at `now`, or null when it may go. */
function refusalFor(
  adapter: string,
  record: BudgetRecord,
  share: number | null,
  now: number,
): TrackerRateLimited | null {
  if (record.limitedUntil !== null && record.limitedUntil > now)
    return new TrackerRateLimited(
      adapter,
      record.limitedUntil,
      record.why ?? "the tracker refused it",
    );
  const spent = spentWindow(record, share, now);
  return spent === null
    ? null
    : new TrackerRateLimited(adapter, spent.resetAt, spent.why);
}

/** The record with one request taken from its balance; null when unchanged. */
function reserved(record: BudgetRecord, now: number): BudgetRecord | null {
  const w = record.requests;
  if (w.remaining === null || w.resetAt === null || w.resetAt <= now)
    return null;
  // The balance as it stands, capped at the limit, from now on: a
  // refill that came while the window was full is not credit.
  const held = holds(w, record.observedAt, now) ?? w.remaining;
  return { ...record, requests: { ...w, remaining: held - 1, readAt: now } };
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
        const refusal = refusalFor(adapter, record, share(), now);
        if (refusal !== null) {
          out.refusal = refusal;
          return null;
        }
        return reserved(record, now);
      });
      if (out.refusal !== null) throw out.refusal;
      return now;
    },
    observe(key, answer, sentAt) {
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
          requests: merged(base.requests, answer.requests, now, sentAt),
          complexity: merged(base.complexity, answer.complexity, now, sentAt),
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
