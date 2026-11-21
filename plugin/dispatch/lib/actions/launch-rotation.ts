import type { ApplyState } from "./launch.ts";

/** Two launch groups and two background stages per repository complete a target turn. */
const TARGET_TURN_PER_REPO = 4;

/** The level of the hierarchy a rotation orders; each is a digit of the tick index, the repositories the lowest. */
export type RotationLevel = "repositories" | "stages" | "targets";

/**
 * `items` in this tick's order: rotated by a digit of the tick's own index, a
 * counter that advances once per applying tick whatever the timer's interval.
 * Target order advances after both launch groups and both background stages
 * have led every repository. A failed open at the front of one stage then
 * cannot keep every later target waiting across successive opportunities.
 * The global repository and stage order is applied by `apply-order.ts`.
 */
export function rotated<T>(
  state: ApplyState,
  items: T[],
  level: RotationLevel = "repositories",
): T[] {
  if (items.length < 2 || state.tick === undefined) return items;
  const repos = Math.max(1, state.repos ?? 1);
  const divisor =
    level === "repositories"
      ? 1
      : level === "stages"
        ? repos
        : repos * TARGET_TURN_PER_REPO;
  const start = Math.floor(state.tick / divisor) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}
