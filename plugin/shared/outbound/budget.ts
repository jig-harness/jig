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
import { errnoCode, swallow } from "../errors.ts";
import { JigError } from "../outcome.ts";
import { inTransaction, openDatabase } from "../records/db.ts";
import { currentMs, isoFromMs } from "../time.ts";
import { orNull, validWindow } from "./budget-shape.ts";

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
  /**
   * When an answer last reported this window's balance, epoch milliseconds;
   * a reservation does not move it. Absent: never reported.
   */
  answeredAt?: number | null;
  /**
   * The window's reset is a guess, rolled forward by a reservation after
   * the last reported reset passed; the next answer that reports the
   * window replaces it.
   */
  estimated?: boolean;
  /**
   * The send time of the snapshot that last replaced this window's balance:
   * a request admitted before it is already settled in that balance.
   */
  snapshotSentAt?: number | null;
  /**
   * The times of the reservations the last reading does not count, oldest
   * first: a snapshot sent at `t` has them all but those made at or after
   * `t` in its balance. Absent: none recorded.
   */
  pending?: number[];
  /**
   * Reservations forgotten beyond `PENDING_CAP`: how many, and the newest
   * one's time. A snapshot sent at or before that time counts them all as
   * unsettled, which under-credits at worst; none is ever given back.
   */
  overflow?: { count: number; at: number };
  /**
   * When an ordinary answer last reported this window. A snapshot sent
   * before it does not know of that answer's spending, so it cannot raise
   * the balance above it.
   */
  answeredOrdinarilyAt?: number;
}

/** How many unsettled reservations a window remembers one by one. */
const PENDING_CAP = 256;

/** The window's unsettled reservations with one more at `at`, and what the cap forgot. */
function withPending(
  w: BudgetWindow,
  at: number,
): Pick<BudgetWindow, "pending" | "overflow"> {
  const all = [...(w.pending ?? []), at];
  const forgotten = all.slice(0, Math.max(0, all.length - PENDING_CAP));
  const overflow =
    forgotten.length === 0
      ? w.overflow
      : {
          count: (w.overflow?.count ?? 0) + forgotten.length,
          at: Math.max(w.overflow?.at ?? 0, ...forgotten),
        };
  return {
    pending: all.slice(-PENDING_CAP),
    ...(overflow === undefined ? {} : { overflow }),
  };
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
  /**
   * Limits a system reports beside the request count and the complexity
   * (GitHub's search), by name; absent when it reports none.
   */
  windows?: Record<string, BudgetWindow>;
  /** Refusals in a row that named no wait; each holds the credential longer. */
  strikes?: number;
}

/** What one answer said: the windows it reported, and whether it refused the credential and until when. */
export interface BudgetAnswer {
  requests?: BudgetWindow;
  complexity?: BudgetWindow;
  /** The other limits it reported, by the names the record keeps them under. */
  windows?: Record<string, BudgetWindow>;
  /**
   * The answer reports the whole balance of each window it names, as
   * GitHub's `rate_limit` endpoint does: it replaces what the record holds,
   * reservations included, rather than taking the lower count.
   */
  snapshot?: boolean;
  limitedUntil?: number;
  /**
   * A refusal that named no wait: the credential is held for `floorMs`,
   * doubled for each refusal in a row before it, up to `capMs`.
   */
  unnamedRefusal?: { floorMs: number; capMs: number };
  why?: string;
}

/**
 * Which of a record's windows a request is admitted against (each must hold
 * more than the caller's floor), and which one it reserves a request of;
 * by default the request count and the complexity, reserving a request.
 */
export interface AdmitOptions {
  windows?: readonly string[];
  /** `null` reserves nothing: what the request costs is known only from its answer. */
  reserve?: string | null;
  /**
   * How long the reserved window lasts, for a window that resets whole: a
   * reservation after its reset starts the next window of that length,
   * instead of reserving nothing.
   */
  rollMs?: number;
  /** Told the window the request actually reserved in: `null` when it reserved nothing, whatever `reserve` asked. */
  onReserved?: (reservedIn: string | null) => void;
  /** Throw a store's contention to the caller rather than wait for it. */
  nonblocking?: boolean;
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
      `${adapter}'s rate limit for this credential is spent until ${isoFromMs(resetAt)}: ${reason}`,
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
   * `nonblocking` throws a store's `SQLITE_BUSY` instead of waiting for it.
   */
  update(
    key: string,
    change: (prev: BudgetRecord | null) => BudgetRecord | null,
    nonblocking?: boolean,
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

function validWindows(w: unknown): boolean {
  if (w === undefined) return true;
  return (
    typeof w === "object" &&
    w !== null &&
    !Array.isArray(w) &&
    Object.values(w).every(validWindow)
  );
}

/** A record read from the store only when every field has its shape; a damaged one reads as none. */
function validRecord(value: unknown): value is BudgetRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    validWindow(r.requests) &&
    validWindow(r.complexity) &&
    validWindows(r.windows) &&
    (r.strikes === undefined || orNull(r.strikes, (n) => n >= 0)) &&
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
    update(key, change, nonblocking) {
      try {
        const d = open();
        if (d === null) return;
        inTransaction(
          d,
          () => {
            const next = change(get(d, key));
            if (next === null) return;
            d.query(
              "INSERT OR REPLACE INTO tracker_budget (key, value) VALUES (?, ?)",
            ).run(key, JSON.stringify(next));
          },
          nonblocking ? 0 : undefined,
        );
      } catch (error) {
        if (nonblocking && errnoCode(error) === "SQLITE_BUSY") throw error;
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
  admit(adapter: string, key: string, opts?: AdmitOptions): number;
  /**
   * Record what one answer said. `sentAt` is the `admit` time of the request
   * it answers: what was recorded since is not in the answer. `reservedIn`
   * names the window that request reserved, `null` for one that reserved
   * nothing; left out, it is read as the window `admit` reserves by default.
   */
  observe(
    key: string,
    answer: BudgetAnswer,
    sentAt?: number,
    reservedIn?: string | null,
  ): void;
  /** Until when the credential is held after the answers recorded so far, epoch milliseconds; `null` when it is not. */
  heldUntil?(key: string): number | null;
  /**
   * Give back the request `admit` reserved in window `name` at `sentAt`,
   * for a request that was never sent or that the system did not charge.
   */
  release?(key: string, name: string, sentAt: number): void;
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
/**
 * An ordinary answer as the stored window holds it. The settlement watermark
 * of the last snapshot stays: `release` relies on it to give back nothing a
 * snapshot already credited.
 */
function ordinaryRead(
  prev: BudgetWindow,
  next: BudgetWindow,
  now: number,
): BudgetWindow {
  return {
    ...next,
    readAt: now,
    answeredAt: now,
    ...(prev.snapshotSentAt == null
      ? {}
      : { snapshotSentAt: prev.snapshotSentAt }),
    ...(prev.overflow === undefined ? {} : { overflow: prev.overflow }),
    answeredOrdinarilyAt: now,
  };
}

/**
 * A guessed reset yields to an answer that reports the current window, not to
 * one from a window that has already ended.
 */
function yieldsEstimate(
  prev: BudgetWindow,
  next: BudgetWindow,
  now: number,
): boolean {
  return (
    prev.estimated === true && (next.resetAt === null || next.resetAt > now)
  );
}

function merged(
  prev: BudgetWindow,
  next: BudgetWindow | undefined,
  now: number,
  sentAt: number | undefined,
  requestReserved = true,
): BudgetWindow {
  if (next === undefined) return prev;
  const read = ordinaryRead(prev, next, now);
  const { settled, adopted } = reconciliation(
    prev,
    read,
    sentAt ?? now,
    requestReserved,
  );
  const kept = (remaining: number | null): BudgetWindow => ({
    ...read,
    remaining,
    ...(prev.pending === undefined ? {} : { pending: prev.pending }),
  });
  const count = next.remaining;
  if (count !== null && yieldsEstimate(prev, next, now)) return adopted(count);
  if (count === null) return olderWindow(prev, next) ? prev : kept(null);
  if (sameResetWindow(prev, next) && prev.remaining !== null)
    return settled(count) < prev.remaining
      ? adopted(count)
      : kept(prev.remaining);
  if (olderWindow(prev, next)) return prev;
  const carried = carriedBalance(prev, next, now, sentAt);
  if (carried === null) return adopted(count);
  return settled(count) < carried ? adopted(count) : kept(carried);
}

/**
 * How an ordinary answer's balance is reconciled with a stored window. The
 * answer's balance counts the reservations made before its request was sent,
 * and none made since: it stands only with those deducted and kept pending,
 * so a release gives back exactly what was taken. A balance that is not the
 * answer's already holds every deduction, and keeps them all.
 */
function reconciliation(
  prev: BudgetWindow,
  read: BudgetWindow,
  sent: number,
  requestReserved: boolean,
): {
  settled: (count: number) => number;
  adopted: (count: number | null) => BudgetWindow;
} {
  const pending = prev.pending ?? [];
  // Reservations at the request's own millisecond cannot be told from it:
  // when the request reserved in this window one of them is the request and
  // the rest were made after it was sent; when it reserved nothing, all were.
  // Forgotten ones (past `PENDING_CAP`) count as later too; when some were
  // forgotten at that millisecond the request may be one: under-credit.
  const overflow =
    prev.overflow !== undefined && prev.overflow.at >= sent
      ? prev.overflow
      : undefined;
  const forgotten = overflow?.count ?? 0;
  const atSent = pending.filter((t) => t === sent).length;
  const later = [
    ...pending.filter((t) => t > sent),
    ...Array<number>(
      Math.max(0, atSent - (requestReserved && overflow === undefined ? 1 : 0)),
    ).fill(sent),
  ];
  return {
    // What the answer's balance comes to once every later reservation is
    // taken from it: the figure to compare with a stored balance.
    settled: (count) => count - later.length - forgotten,
    adopted: (count) => {
      // A balance cannot go below zero: a reservation it has no room to
      // deduct is not kept pending, so its release gives back nothing.
      const deducted =
        count === null ? 0 : Math.min(later.length + forgotten, count);
      const keep = Math.min(later.length, deducted);
      return {
        ...read,
        remaining: count === null ? null : count - deducted,
        ...(prev.pending === undefined
          ? {}
          : { pending: later.slice(later.length - keep) }),
      };
    },
  };
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
  names: readonly string[],
): { resetAt: number; why: string } | null {
  let binding: { resetAt: number; why: string } | null = null;
  for (const name of names) {
    const w = windowOf(record, name);
    if (w === undefined) continue;
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
  const unit = name === "complexity" ? 0 : 1;
  const empty = unit > 0 ? held < unit : held <= 0;
  if (held > floor && !empty) return null;
  return {
    resetAt: usableAt({ ...w, resetAt: w.resetAt }, held, floor, now),
    why: empty
      ? `no ${name} left in the window`
      : `the dispatcher's share (${Math.round((share ?? 0) * 100)}%) of the ${name} window is spent; ${Math.floor(held)} of ${w.limit} are left to passes and people`,
  };
}

/** The window a record keeps under `name`. */
function windowOf(
  record: BudgetRecord,
  name: string,
): BudgetWindow | undefined {
  if (name === "requests") return record.requests;
  if (name === "complexity") return record.complexity;
  return record.windows?.[name];
}

const DEFAULT_WINDOWS = ["requests", "complexity"] as const;

/** Why a request is refused at `now`, or null when it may go. */
function refusalFor(
  adapter: string,
  record: BudgetRecord,
  share: number | null,
  now: number,
  names: readonly string[] = DEFAULT_WINDOWS,
): TrackerRateLimited | null {
  if (record.limitedUntil !== null && record.limitedUntil > now)
    return new TrackerRateLimited(
      adapter,
      record.limitedUntil,
      record.why ?? "the tracker refused it",
    );
  const spent = spentWindow(record, share, now, names);
  return spent === null
    ? null
    : new TrackerRateLimited(adapter, spent.resetAt, spent.why);
}

/** The record with one request taken from the balance of its window `name`; null when unchanged. */
function reserved(
  record: BudgetRecord,
  now: number,
  name: string | null = "requests",
  rollMs?: number,
): BudgetRecord | null {
  const w = name === null ? undefined : windowOf(record, name);
  if (name === null || w === undefined || w.remaining === null) return null;
  if (w.resetAt === null) return null;
  if (w.resetAt <= now) {
    // The reported window is over and no answer has said the next one: a
    // reservation starts it, so the share can still bind.
    if (rollMs === undefined || w.limit === null || w.limit < 1) return null;
    return withWindow(record, name, {
      limit: w.limit,
      remaining: w.limit - 1,
      resetAt: now + rollMs,
      readAt: now,
      answeredAt: w.answeredAt ?? null,
      estimated: true,
      pending: [now],
    });
  }
  // The balance as it stands, capped at the limit, from now on: a
  // refill that came while the window was full is not credit.
  const held = holds(w, record.observedAt, now) ?? w.remaining;
  return withWindow(record, name, {
    ...w,
    remaining: held - 1,
    readAt: now,
    ...withPending(w, now),
  });
}

/** The record with its window `name` replaced. */
function withWindow(
  record: BudgetRecord,
  name: string,
  w: BudgetWindow,
): BudgetRecord {
  if (name === "requests") return { ...record, requests: w };
  if (name === "complexity") return { ...record, complexity: w };
  return { ...record, windows: { ...record.windows, [name]: w } };
}

/** The record's other windows with what an answer said of each merged in. */
function mergedWindows(
  prev: Record<string, BudgetWindow> | undefined,
  next: Record<string, BudgetWindow> | undefined,
  now: number,
  sentAt: number | undefined,
  reservedIn: string | null,
): Record<string, BudgetWindow> | undefined {
  if (next === undefined) return prev;
  const out: Record<string, BudgetWindow> = { ...prev };
  for (const [name, w] of Object.entries(next))
    out[name] = merged(
      prev?.[name] ?? EMPTY,
      w,
      now,
      sentAt,
      reservedIn === name,
    );
  return out;
}

/**
 * Until when an answer holds the credential, with the refusals in a row it
 * leaves; `null` when it holds nothing. Only an answer to a request sent
 * once the last hold had ended moves the count: the other refusals of one
 * burst share its hold, and a success that was already on its way when the
 * credential was refused does not clear it.
 */
function holdOf(
  answer: BudgetAnswer,
  base: BudgetRecord,
  now: number,
  sentAt: number | undefined,
): { until: number | null; strikes: number } {
  const strikes = base.strikes ?? 0;
  const fresh =
    sentAt === undefined ||
    base.limitedUntil === null ||
    sentAt >= base.limitedUntil;
  const struck = fresh ? strikes + 1 : Math.max(1, strikes);
  if (answer.limitedUntil !== undefined)
    return { until: answer.limitedUntil, strikes: struck };
  const unnamed = answer.unnamedRefusal;
  if (unnamed !== undefined)
    return {
      until:
        now +
        Math.min(
          unnamed.capMs,
          unnamed.floorMs * 2 ** Math.min(struck - 1, 30),
        ),
      strikes: struck,
    };
  return { until: null, strikes: fresh ? 0 : strikes };
}

/**
 * The windows a snapshot answer reports, taken as they are: it charges
 * nothing and counts every caller's spending up to the time its request was
 * sent. Spending recorded since (`readAt` at or after `sentAt`) is not in
 * it, so within one window the lower count stands.
 */
/** A snapshot delayed across a reset says nothing of the window since. */
function delayedAcrossReset(
  prev: BudgetWindow,
  next: BudgetWindow,
  now: number,
): boolean {
  return prev.estimated === true
    ? next.resetAt !== null && next.resetAt <= now
    : olderWindow(prev, next);
}

/**
 * The snapshot's window `read`, with the balance of an ordinary answer
 * recorded since its request was sent when that answer holds spending the
 * snapshot cannot know of: the lower balance of one window stands.
 */
function keepNewerOrdinary(
  prev: BudgetWindow,
  read: BudgetWindow,
  counted: number,
  since: number,
): BudgetWindow {
  const ordinaryAt = prev.answeredOrdinarilyAt;
  const newer =
    ordinaryAt !== undefined &&
    ordinaryAt >= since &&
    prev.remaining !== null &&
    read.resetAt === prev.resetAt;
  if (!newer) return { ...read, remaining: counted };
  // The balance kept is the one whose deductions are kept with it: when the
  // ordinary answer's lower balance stands, so do the reservations it counted,
  // or a release could no longer give one back.
  if ((prev.remaining as number) < counted)
    return {
      ...read,
      remaining: prev.remaining as number,
      answeredOrdinarilyAt: ordinaryAt,
      pending: prev.pending ?? [],
      ...(prev.overflow === undefined ? {} : { overflow: prev.overflow }),
    };
  return { ...read, remaining: counted, answeredOrdinarilyAt: ordinaryAt };
}

function snapshotOf(
  prev: BudgetWindow,
  next: BudgetWindow | undefined,
  now: number,
  sentAt: number | undefined,
): BudgetWindow {
  if (next === undefined || delayedAcrossReset(prev, next, now)) return prev;
  const since = sentAt ?? now;
  // An older snapshot than the one the record holds says less than it does.
  if (prev.snapshotSentAt != null && since < prev.snapshotSentAt) return prev;
  // What the snapshot cannot count: the reservations made since its request
  // was sent. Those made before it are in its balance, and settled.
  const pending = (prev.pending ?? []).filter((t) => t >= since);
  const forgotten =
    prev.overflow !== undefined && prev.overflow.at >= since
      ? prev.overflow
      : undefined;
  const read: BudgetWindow = {
    ...next,
    readAt: now,
    answeredAt: now,
    snapshotSentAt: since,
    pending,
    ...(forgotten === undefined ? {} : { overflow: forgotten }),
  };
  if (next.remaining === null) return read;
  const counted = next.remaining - pending.length - (forgotten?.count ?? 0);
  return keepNewerOrdinary(prev, read, counted, since);
}

/** A governor over `store`; `clock` and `share` are for tests. */
export function budgetGovernor(
  store: BudgetStore,
  opts: { clock?: () => number; share?: () => number | null } = {},
): BudgetGovernor {
  const clock = opts.clock ?? currentMs;
  const share = opts.share ?? currentShare;
  return {
    admit(adapter, key, opts = {}) {
      const now = clock();
      const out = {
        refusal: null as TrackerRateLimited | null,
        reservedIn: null as string | null,
      };
      // The decision and the reservation of one request are one transaction,
      // so concurrent callers each spend their own part of the balance.
      const decide = (record: BudgetRecord | null): BudgetRecord | null => {
        if (record === null) return null;
        const refusal = refusalFor(
          adapter,
          record,
          share(),
          now,
          opts.windows ?? DEFAULT_WINDOWS,
        );
        if (refusal !== null) {
          out.refusal = refusal;
          return null;
        }
        const name = opts.reserve === undefined ? "requests" : opts.reserve;
        const next = reserved(record, now, name, opts.rollMs);
        out.reservedIn = next === null ? null : name;
        return next;
      };
      store.update(key, decide, opts.nonblocking);
      if (out.refusal !== null) throw out.refusal;
      opts.onReserved?.(out.reservedIn);
      return now;
    },
    observe(key, answer, sentAt, reservedIn = "requests") {
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
        const hold = holdOf(answer, base, now, sentAt);
        const windows =
          answer.snapshot === true && answer.windows !== undefined
            ? {
                ...base.windows,
                ...stamped(base.windows, answer.windows, now, sentAt),
              }
            : mergedWindows(
                base.windows,
                answer.windows,
                now,
                sentAt,
                reservedIn,
              );
        const take = (
          prev: BudgetWindow,
          next: BudgetWindow | undefined,
          name: string,
        ) =>
          answer.snapshot === true
            ? snapshotOf(prev, next, now, sentAt)
            : merged(prev, next, now, sentAt, reservedIn === name);
        return {
          requests: take(base.requests, answer.requests, "requests"),
          complexity: take(base.complexity, answer.complexity, "complexity"),
          limitedUntil:
            hold.until !== null
              ? Math.max(
                  hold.until,
                  stillLimited ? (base.limitedUntil as number) : 0,
                )
              : stillLimited
                ? base.limitedUntil
                : null,
          why: answer.why ?? (stillLimited ? base.why : null),
          observedAt: now,
          ...(windows === undefined ? {} : { windows }),
          ...(hold.strikes === 0 ? {} : { strikes: hold.strikes }),
        };
      });
    },
    heldUntil(key) {
      const record = store.read(key);
      return record?.limitedUntil != null && record.limitedUntil > clock()
        ? record.limitedUntil
        : null;
    },
    release(key, name, sentAt) {
      const now = clock();
      store.update(key, (record) => {
        const w = record === null ? undefined : windowOf(record, name);
        if (
          record === null ||
          w === undefined ||
          w.remaining === null ||
          w.resetAt === null ||
          w.resetAt <= now ||
          w.resetAt <= sentAt ||
          // A reservation a snapshot already settled is not pending: an unsent
          // request is not in what GitHub charged, so nothing is given back.
          (w.pending !== undefined && !w.pending.includes(sentAt))
        )
          return null;
        // One reservation, even where several share a millisecond.
        const at = w.pending?.indexOf(sentAt) ?? -1;
        const pending =
          at < 0 ? w.pending : w.pending?.filter((_, i) => i !== at);
        const remaining =
          w.limit === null
            ? w.remaining + 1
            : Math.min(w.limit, w.remaining + 1);
        return withWindow(record, name, {
          ...w,
          remaining,
          ...(pending === undefined ? {} : { pending }),
        });
      });
    },
  };
}

/** A snapshot's windows read at `now`, each one older than the stored window left out. */
function stamped(
  prev: Record<string, BudgetWindow> | undefined,
  windows: Record<string, BudgetWindow>,
  now: number,
  sentAt: number | undefined,
): Record<string, BudgetWindow> {
  return Object.fromEntries(
    Object.entries(windows).map(([name, w]) => [
      name,
      snapshotOf(prev?.[name] ?? EMPTY, w, now, sentAt),
    ]),
  );
}

let machineGovernor: BudgetGovernor | undefined;

/** The machine's governor, over the store in the Jig state directory. */
export function defaultGovernor(): BudgetGovernor {
  machineGovernor ??= budgetGovernor(sqliteBudgetStore());
  return machineGovernor;
}
