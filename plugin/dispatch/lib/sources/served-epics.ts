/** An epic's children one at a time unless its plan says otherwise, and why an epic is idle. */
import type { QueueItem } from "../queue-rank.ts";
import type { Unplaced } from "../types.ts";

/** The epic an item is a child of when that epic has no execution plan, and its child already in progress. */
export interface Serial {
  epic: string;
  busy?: string | undefined;
}

/** `ranked` best first: each serial epic keeps its first child, and none while a child is in progress. */
export function serializeEpics<
  T extends QueueItem & { serial?: Serial | undefined },
>(ranked: readonly T[], unplaced: Unplaced[]): T[] {
  const leader = new Map<string, string>();
  const kept: T[] = [];
  for (const item of ranked) {
    const serial = item.serial;
    const key = item.issue.identifier;
    const why =
      serial === undefined
        ? null
        : serial.busy !== undefined
          ? `${serial.epic} is working ${serial.busy}; it takes one child at a time`
          : leader.has(serial.epic)
            ? `waiting on ${leader.get(serial.epic)}; ${serial.epic} takes one child at a time`
            : null;
    if (why !== null) {
      unplaced.push({ target: key, record: "tracker", reason: why });
      continue;
    }
    if (serial !== undefined) leader.set(serial.epic, key);
    kept.push(item);
  }
  return kept;
}

export interface EpicWalk {
  key: string;
  children: string[];
  /** A child is already in progress: the epic is working, not idle. */
  working: boolean;
}

/** An epic none of whose open children can start reports one reason of its own, deepest epics first. */
export function summarizeEpics(
  walks: readonly EpicWalk[],
  wanted: ReadonlySet<string>,
  unplaced: Unplaced[],
): void {
  const byKey = new Map(walks.map((w) => [w.key, w]));
  const startable = (key: string, path: ReadonlySet<string>): boolean => {
    if (wanted.has(key)) return true;
    const walk = byKey.get(key);
    if (walk === undefined || path.has(key)) return false;
    const next = new Set(path).add(key);
    return walk.children.some((c) => startable(c, next));
  };
  for (const walk of [...walks].reverse()) {
    if (walk.working || startable(walk.key, new Set())) continue;
    const held = walk.children
      .map((c) => unplaced.find((u) => u.target === c))
      .find((u) => u !== undefined);
    const first = held?.target ?? walk.children[0];
    const why = held?.reason ?? "not ready to start";
    unplaced.push({
      target: walk.key,
      record: "tracker",
      reason: `none of its ${walk.children.length} open children can start; first, ${first}: ${why}`,
    });
  }
}
