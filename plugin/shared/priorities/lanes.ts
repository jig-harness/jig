/**
 * The priority lanes ([design](../../../design/priorities-and-overview.md#lanes-and-their-weights)):
 * every item the ranker sees falls in at most one. `urgent` comes first and
 * `bug-high` next; the four weighted lanes share the remaining starts by
 * weight. A weight is 0 to 100 and 0 takes a lane out of rotation.
 */

/** Every lane, in the order the shortlist places them. */
export const LANES = [
  "urgent",
  "bug-high",
  "core",
  "tactical",
  "peripheral",
  "bug-other",
] as const;
export type Lane = (typeof LANES)[number];

/** The lanes that share starts by weight, in tie order: an objective lane wins a tie over `bug-other`. */
export const WEIGHTED_LANES = [
  "core",
  "tactical",
  "peripheral",
  "bug-other",
] as const;
export type WeightedLane = (typeof WEIGHTED_LANES)[number];

/** The objective classes, each naming the lane its work falls in. */
export const OBJECTIVE_CLASSES = ["core", "tactical", "peripheral"] as const;
export type ObjectiveClass = (typeof OBJECTIVE_CLASSES)[number];

/** The built-in weights, used for a missing file or entry. */
export const DEFAULT_WEIGHTS: Readonly<Record<WeightedLane, number>> = {
  "bug-other": 15,
  core: 50,
  tactical: 25,
  peripheral: 10,
};

export function isWeightedLane(lane: string): lane is WeightedLane {
  return (WEIGHTED_LANES as readonly string[]).includes(lane);
}

/**
 * Each weighted lane's share of the weighted starts: its weight over the sum
 * of the weights in rotation; a lane out of rotation (weight 0, or `null`
 * when its entry failed closed) has share 0.
 */
export function laneShares(
  weights: Readonly<Record<WeightedLane, number | null>>,
): Record<WeightedLane, number> {
  const total = WEIGHTED_LANES.reduce((sum, l) => sum + (weights[l] ?? 0), 0);
  const out = {} as Record<WeightedLane, number>;
  for (const lane of WEIGHTED_LANES)
    out[lane] = total > 0 ? (weights[lane] ?? 0) / total : 0;
  return out;
}
