/** Fitting a ranked list of issues to the point budget and the item limit. */

/**
 * Fill a ranked list up to both limits in one pass: take each item that
 * still fits the point budget and the item limit, and skip (not stop at) one
 * that does not, so an expensive issue that no longer fits leaves room for
 * cheaper ones below it. `pinned` items are taken first and unconditionally,
 * charged against both limits. The result keeps the rank order.
 */
export function fillBudget<T>(
  ranked: readonly T[],
  pointsOf: (item: T) => number,
  opts: { limit: number; budget: number; pinned?: (item: T) => boolean },
): T[] {
  const pinned = opts.pinned ?? (() => false);
  // By position, not by value: two equal items are two slots.
  const chosen = new Set<number>();
  let used = 0;
  ranked.forEach((item, i) => {
    if (!pinned(item)) return;
    chosen.add(i);
    used += pointsOf(item);
  });
  ranked.forEach((item, i) => {
    if (chosen.size >= opts.limit || chosen.has(i)) return;
    const cost = pointsOf(item);
    if (used + cost > opts.budget) return;
    chosen.add(i);
    used += cost;
  });
  return ranked.filter((_, i) => chosen.has(i));
}

/**
 * Fill the budget, never letting an issue anchor's own seed fall out: the
 * seed is the issue the run was invoked to complete. It is pinned, charged
 * against both limits and listed first.
 */
export function capCandidates<T extends { identifier: string; points: number }>(
  ranked: T[],
  opts: { limit: number; budget: number },
  seed: string | null,
): T[] {
  const kept = fillBudget(ranked, (c) => c.points, {
    ...opts,
    pinned: (c) => c.identifier === seed,
  });
  return [
    ...kept.filter((c) => c.identifier === seed),
    ...kept.filter((c) => c.identifier !== seed),
  ];
}
