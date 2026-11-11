/** How far a served item's open blockers are followed to find work to start first. */
import type { Tracker } from "./tracker/port.ts";

export const PULL_DEPTH = 3;

/** The items `key` waits on. */
async function waitsOn(tracker: Tracker, key: string): Promise<string[]> {
  const relations = await tracker.listRelations(key);
  return relations.filter((r) => r.type === "blocked_by").map((r) => r.issue);
}

/** How many items one level reads at once. */
const READ_WIDTH = 4;

/**
 * Whether `blocker` is one of the items `blocked` waits on, directly or
 * through at most `PULL_DEPTH` `blocked_by` links. `through` vets each item the
 * path passes through on the way (never `blocked` or `blocker` themselves):
 * the path is followed only across items it accepts, so a link through an item
 * the queue would not traverse proves nothing.
 */
export async function blocksWithin(
  tracker: Tracker,
  blocked: string,
  blocker: string,
  through: (key: string) => Promise<boolean> = async () => true,
): Promise<boolean> {
  const seen = new Set<string>([blocked]);
  let level = [blocked];
  for (let depth = 0; depth < PULL_DEPTH && level.length > 0; depth++) {
    const next = new Set<string>();
    for (let at = 0; at < level.length; at += READ_WIDTH)
      for (const keys of await Promise.all(
        level.slice(at, at + READ_WIDTH).map((k) => waitsOn(tracker, k)),
      ))
        for (const key of keys) if (!seen.has(key)) next.add(key);
    if (next.has(blocker)) return true;
    for (const key of next) seen.add(key);
    level = [];
    for (const key of next) if (await through(key)) level.push(key);
  }
  return false;
}
