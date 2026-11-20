import type { BudgetWindow } from "./budget.ts";

/** Kept apart from the transport's authoritative GraphQL window. */
const GRAPHQL_POLL_FLOOR = "graphql-poll-floor";
const FLOOR_PREFIX = `${GRAPHQL_POLL_FLOOR}:`;

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

/** Every still-live conflicting GraphQL reading, keyed by its reset window. */
export function graphqlPollFloors(
  windows: Record<string, BudgetWindow> | undefined,
  now: number,
): BudgetWindow[] {
  if (windows === undefined) return [];
  return Object.entries(windows)
    .filter(
      ([name, window]) =>
        (name === GRAPHQL_POLL_FLOOR || name.startsWith(FLOOR_PREFIX)) &&
        live(window, now),
    )
    .map(([, window]) => window);
}

/**
 * Keep each conflicting live reading until its own reset instead of replacing
 * it with the newest low reading; without a latest reading, nothing changes. Older installations' single floor is read
 * and migrated on the next observation.
 */
export function withGraphqlPollFloors(
  windows: Record<string, BudgetWindow> | undefined,
  observed: readonly (BudgetWindow | undefined)[],
  now: number,
): Record<string, BudgetWindow> | undefined {
  if (observed[1] === undefined) return windows;
  const retained = Object.fromEntries(
    Object.entries(windows ?? {}).filter(
      ([name]) => name !== GRAPHQL_POLL_FLOOR && !name.startsWith(FLOOR_PREFIX),
    ),
  );
  const floors = new Map<string, BudgetWindow>();
  for (const window of [...graphqlPollFloors(windows, now), ...observed]) {
    if (!live(window, now)) continue;
    // A reset can carry several capacities. Keep each capacity's lower
    // balance: one may be the absolute floor while another has the stricter
    // percentage, and collapsing them would let a later snapshot raise the
    // polling allowance.
    const key = `${window.resetAt}:${window.limit ?? "unknown"}`;
    const previous = floors.get(key);
    floors.set(
      key,
      previous === undefined
        ? window
        : (lowerGraphqlBalance([previous, window], now) ?? window),
    );
  }
  return {
    ...retained,
    ...Object.fromEntries(
      [...floors].map(([key, window]) => [`${FLOOR_PREFIX}${key}`, window]),
    ),
  };
}

/** The local GitHub balances for one credential, as `githubBalances` reads them. */
export interface GithubBalances {
  core: BudgetWindow;
  graphql: BudgetWindow;
  observedAt: number;
  credential?: string;
  windows?: Record<string, BudgetWindow>;
}
