import type { BudgetWindow } from "./budget.ts";

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
