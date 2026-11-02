/**
 * Since when each claimed item has had no running session, in the state
 * database's `idle` table, one row per repository and item: written the
 * first tick that finds the item claimed (in its in-progress state) with no
 * running session and no launch record holding it, and removed the first
 * tick that finds a session for it again or the item no longer claimed. A
 * claimed item idle for longer than `dispatch.stalled_after` is a stalled
 * pickup: reported, never relaunched. The clock starts when a tick first
 * sees the item idle, so a tick that did not run meanwhile reports it late,
 * never early.
 */
import { stateRoot } from "../receipts.ts";
import { inTransaction, stateDb } from "./state.ts";

/** Since when each of `repo`'s claimed items has been idle, in milliseconds. */
export function readIdle(
  repo: string,
  root = stateRoot(),
): Map<string, number> {
  const rows = stateDb(root)
    .query("SELECT item, since FROM idle WHERE repo = ?")
    .all(repo) as Array<{ item: string; since: number }>;
  return new Map(rows.map((r) => [r.item, r.since]));
}

/**
 * Start the clock of each item idle now that has none, and stop the clock
 * of every other item of `repo` except those in `keep`, whose idleness could
 * not be told this tick.
 */
export function updateIdle(
  repo: string,
  idleNow: ReadonlyArray<string>,
  nowMs: number,
  root = stateRoot(),
  keep: ReadonlyArray<string> = [],
): void {
  const idle = new Set(idleNow);
  const unknown = new Set(keep);
  const db = stateDb(root);
  const stop = db.query("DELETE FROM idle WHERE repo = ? AND item = ?");
  const start = db.query(
    "INSERT INTO idle (repo, item, since) VALUES (?, ?, ?) ON CONFLICT (repo, item) DO NOTHING",
  );
  inTransaction(db, () => {
    for (const item of readIdle(repo, root).keys())
      if (!idle.has(item) && !unknown.has(item)) stop.run(repo, item);
    for (const item of idle) start.run(repo, item, nowMs);
  });
}
