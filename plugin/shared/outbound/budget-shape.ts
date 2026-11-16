import { swallow } from "../errors.ts";
import type { BudgetRecord, BudgetWindow } from "./budget.ts";

// Whether a value read back from the store has the shape of a window.

export const orNull = (v: unknown, ok: (n: number) => boolean): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v) && ok(v));

const nonNegative = (n: number): boolean => n >= 0;
const optionalNonNegative = (v: unknown): boolean =>
  v === undefined || orNull(v, nonNegative);

function validPending(pending: unknown): boolean {
  return (
    pending === undefined ||
    (Array.isArray(pending) &&
      pending.every((t) => typeof t === "number" && Number.isFinite(t)))
  );
}

function validOverflow(overflow: unknown): boolean {
  if (overflow === undefined) return true;
  if (typeof overflow !== "object" || overflow === null) return false;
  const { count, at } = overflow as { count?: unknown; at?: unknown };
  return (
    Number.isSafeInteger(count) &&
    (count as number) >= 0 &&
    at !== null &&
    orNull(at, nonNegative)
  );
}

export function validWindow(w: unknown): w is BudgetWindow {
  if (typeof w !== "object" || w === null) return false;
  const r = w as Record<string, unknown>;
  return (
    orNull(r.limit, nonNegative) &&
    orNull(r.remaining, () => true) &&
    orNull(r.resetAt, nonNegative) &&
    (r.refillMs === undefined || orNull(r.refillMs, (n) => n > 0)) &&
    [r.readAt, r.answeredAt, r.snapshotSentAt, r.answeredOrdinarilyAt].every(
      optionalNonNegative,
    ) &&
    validPending(r.pending) &&
    validOverflow(r.overflow) &&
    (r.estimated === undefined || typeof r.estimated === "boolean")
  );
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
