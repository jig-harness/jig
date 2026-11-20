/** The epics a served item is walked through, for its hold and its candidate. */

/**
 * The item's own epics, outermost to nearest (`steps` runs nearest first),
 * then each further epic the walk reached it through: a pulled blocker's
 * walk carries the epics of the item it is pulled forward for.
 */
export function chainOf(
  steps: ReadonlyArray<{ parent: { identifier: string } }>,
  walked: readonly string[] | undefined,
): string[] {
  const own = steps.map((s) => s.parent.identifier).reverse();
  return [...own, ...(walked ?? []).filter((key) => !own.includes(key))];
}
