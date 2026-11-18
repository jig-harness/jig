import {
  type BudgetRecord,
  budgetGovernor,
  memoryBudgetStore,
} from "../outbound/budget.ts";

export const RESET = 2_000_000;

export function emptyRecord(): BudgetRecord {
  return {
    requests: { limit: null, remaining: null, resetAt: null },
    complexity: { limit: null, remaining: null, resetAt: null },
    limitedUntil: null,
    why: null,
    observedAt: 1,
  };
}

/**
 * A governor on a memory store whose clock the test moves, seeded with a
 * requests balance read at the clock's start (`stamped`), or with a balance
 * that carries no read time.
 */
export function seededBudget(key: string, balance: number, stamped = true) {
  const clock = { now: 1_000_000 };
  const store = memoryBudgetStore();
  const governor = budgetGovernor(store, {
    clock: () => clock.now,
    share: () => null,
  });
  store.update(key, () => ({
    ...emptyRecord(),
    requests: {
      limit: 5000,
      remaining: balance,
      resetAt: RESET,
      ...(stamped ? { readAt: clock.now } : {}),
    },
  }));
  const window = (remaining: number) => ({
    limit: 5000,
    remaining,
    resetAt: RESET,
  });
  return {
    clock,
    governor,
    store,
    remaining: () => store.read(key)?.requests.remaining,
    reserve: () => governor.admit("GitHub", key, { reserve: "requests" }),
    answer: (remaining: number, sentAt: number) =>
      governor.observe(key, { requests: window(remaining) }, sentAt),
    snapshot: (remaining: number, sentAt: number) =>
      governor.observe(
        key,
        { snapshot: true, requests: window(remaining) },
        sentAt,
      ),
    release: (sentAt: number) => governor.release?.(key, "requests", sentAt),
  };
}
