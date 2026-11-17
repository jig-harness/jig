/** Deterministic shares of launches from launch records, with no reserved slots. */
import { cohortLaunchOrdinal } from "./account-ordinal.ts";
import type { MachineAccount } from "./machine-config.ts";
import type { ReadRecord } from "./launches.ts";

/** A sequence spread evenly through [0, 1), by reflecting an integer's binary digits across the decimal point. */
function phase(position: number): number {
  let fraction = 0;
  let place = 0.5;
  while (position > 0) {
    fraction += (position % 2) * place;
    position = Math.floor(position / 2);
    place /= 2;
  }
  return fraction;
}

/**
 * Give each eligible account an interval proportional to its weight, then
 * visit the intervals with the evenly spread van der Corput sequence. This
 * supports fractional weights without building a potentially huge period.
 * Only accounts in the currently eligible cohort contribute their launch
 * ordinals, retained in their newest records when older records are pruned;
 * an unavailable account leaves no owed launches to catch up on later.
 * Equal weights use the original last-account turn in accounts.ts.
 */
export function weightedTurn<T extends { account: MachineAccount }>(
  eligible: T[],
  weight: (entry: T) => number,
  records: readonly ReadRecord[],
): T {
  const position = cohortLaunchOrdinal(
    records,
    eligible.map((entry) => entry.account),
  );
  // Scaling by the largest weight preserves every interval's share while
  // keeping the sum away from subnormal precision loss.
  const largest = Math.max(...eligible.map(weight));
  const total = eligible.reduce(
    (sum, entry) => sum + weight(entry) / largest,
    0,
  );
  let cursor = phase(position + 1) * total;
  for (const entry of eligible) {
    cursor -= weight(entry) / largest;
    if (cursor < 0) return entry;
  }
  return eligible[eligible.length - 1] as T;
}
