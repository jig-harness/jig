import type { BudgetWindow } from "./budget.ts";

/** Kept apart from the transport's authoritative GraphQL window. */
export const GRAPHQL_POLL_FLOOR = "graphql-poll-floor";

function live(
  window: BudgetWindow | undefined,
  now: number,
): window is BudgetWindow & {
  remaining: number;
  resetAt: number;
} {
  return (
    window?.remaining != null && window.resetAt != null && window.resetAt > now
  );
}

/** Alternating live reset windows cannot raise the allowance of waiting readers. */
export function lowerGraphqlBalance(
  windows: readonly (BudgetWindow | undefined)[],
  now: number,
): BudgetWindow | undefined {
  let lowest:
    | (BudgetWindow & { remaining: number; resetAt: number })
    | undefined;
  const capacities = new Set<number>();
  for (const window of windows) {
    if (!live(window, now)) continue;
    if (window.limit !== null && window.limit > 0) capacities.add(window.limit);
    if (
      lowest === undefined ||
      window.remaining < lowest.remaining ||
      (window.remaining === lowest.remaining && window.resetAt > lowest.resetAt)
    ) {
      lowest = window;
    }
  }
  if (lowest !== undefined && lowest.limit === null && capacities.size === 1) {
    const [limit] = capacities;
    if (limit !== undefined) return { ...lowest, limit };
  }
  return lowest;
}
