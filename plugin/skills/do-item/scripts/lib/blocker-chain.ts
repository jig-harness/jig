/** How far a served item's open blockers are followed to find work to start first. */
import type { Tracker } from "./tracker/port.ts";

export const PULL_DEPTH = 3;

/** The items `key` waits on. */
async function waitsOn(tracker: Tracker, key: string): Promise<string[]> {
  const relations = await tracker.listRelations(key);
  return relations.filter((r) => r.type === "blocked_by").map((r) => r.issue);
}

/**
 * Whether `blocker` is one of the items `blocked` waits on, directly or
 * through at most `PULL_DEPTH` `blocked_by` links.
 */
export async function blocksWithin(
  tracker: Tracker,
  blocked: string,
  blocker: string,
): Promise<boolean> {
  const seen = new Set<string>([blocked]);
  let level = [blocked];
  for (let depth = 0; depth < PULL_DEPTH && level.length > 0; depth++) {
    const next = (await Promise.all(level.map((k) => waitsOn(tracker, k))))
      .flat()
      .filter((k) => !seen.has(k));
    if (next.includes(blocker)) return true;
    for (const key of next) seen.add(key);
    level = next;
  }
  return false;
}
