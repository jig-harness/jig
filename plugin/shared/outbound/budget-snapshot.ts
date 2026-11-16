/**
 * How a snapshot answer, one that reports the whole balance of each window
 * it names (GitHub's `rate_limit` endpoint), replaces what a budget record
 * holds (`budget.ts`), and what it shows was spent beyond the record's count.
 */
import type { BudgetRecord, BudgetWindow, Unexplained } from "./budget.ts";

/** A window no answer has reported. */
export const EMPTY: BudgetWindow = {
  limit: null,
  remaining: null,
  resetAt: null,
};

/** The answer is from a window that ended before the stored one. */
export function olderWindow(prev: BudgetWindow, next: BudgetWindow): boolean {
  return (
    prev.resetAt !== null &&
    next.resetAt !== null &&
    next.resetAt < prev.resetAt
  );
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

export function snapshotOf(
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

/**
 * How far a snapshot lowered each of the request and complexity windows
 * below the balance the record held for the same window: spending no
 * answer or reservation the record counted explains. A window the snapshot
 * left as it was, or that it reports for another reset, shows none.
 */
export function unexplainedSpending(
  before: BudgetRecord,
  after: Pick<BudgetRecord, "requests" | "complexity">,
): Unexplained {
  const out: Unexplained = {};
  for (const name of ["requests", "complexity"] as const) {
    const prev = before[name];
    const next = after[name];
    if (
      next === prev ||
      prev.remaining === null ||
      next.remaining === null ||
      prev.resetAt === null ||
      prev.estimated === true ||
      next.resetAt !== prev.resetAt
    )
      continue;
    const spent = prev.remaining - next.remaining;
    if (spent > 0) out[name] = spent;
  }
  return out;
}

/** A snapshot's windows read at `now`, each one older than the stored window left out. */
export function stamped(
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
