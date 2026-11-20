/**
 * The overlap walk's two records in the state database
 * (design/overlap-aware-admission.md):
 *
 * - `overlap_waits` (`dispatch-overlap-wait`), one row per repository and
 *   wanted pickup: since when it has waited on overlap (the first tick that
 *   put it in tier 2 or 3), since when it was first in tier 3, and when it
 *   was promoted past the bound. A row is kept while the item is wanted and
 *   not started, and removed by the first tick, whose tracker read was whole,
 *   that finds it started or no longer wanted, so a later wait starts again.
 * - `overlap_hotspots` (`dispatch-overlap-hotspot`), one row per repository,
 *   day (UTC) and file: in how many ticks of that day the file kept a pickup
 *   over the overlap bound. Rows older than the day before are removed.
 */
import { stateRoot } from "../receipts.ts";
import type { Wait } from "./overlap.ts";
import { inTransaction, stateDb } from "./state.ts";

interface WaitRow {
  item: string;
  since_ms: number;
  tier3_since_ms: number | null;
  promoted_ms: number | null;
}

/** Each of `repo`'s pickups waiting on overlap, by item. */
export function readWaits(repo: string, root = stateRoot()): Map<string, Wait> {
  const rows = stateDb(root)
    .query(
      "SELECT item, since_ms, tier3_since_ms, promoted_ms FROM overlap_waits WHERE repo = ?",
    )
    .all(repo) as WaitRow[];
  return new Map(
    rows.map((r) => [
      r.item,
      {
        sinceMs: r.since_ms,
        tier3SinceMs: r.tier3_since_ms,
        promotedMs: r.promoted_ms,
      },
    ]),
  );
}

/**
 * Keep the waits the walk left (`waits`, by item; `null` for one that does
 * not wait), and, when `wanted` is known, remove every other row of `repo`
 * whose item is not in it: started, or no longer wanted.
 */
export function settleWaits(
  repo: string,
  waits: ReadonlyMap<string, Wait | null>,
  wanted: ReadonlySet<string> | null,
  root = stateRoot(),
): void {
  const db = stateDb(root);
  const put = db.query(
    `INSERT INTO overlap_waits (repo, item, since_ms, tier3_since_ms, promoted_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo, item) DO UPDATE SET since_ms = excluded.since_ms, tier3_since_ms = excluded.tier3_since_ms, promoted_ms = excluded.promoted_ms`,
  );
  const drop = db.query(
    "DELETE FROM overlap_waits WHERE repo = ? AND item = ?",
  );
  inTransaction(db, () => {
    for (const [item, wait] of waits) {
      if (wait === null) drop.run(repo, item);
      else
        put.run(repo, item, wait.sinceMs, wait.tier3SinceMs, wait.promotedMs);
    }
    if (wanted === null) return;
    for (const item of readWaits(repo, root).keys())
      if (!wanted.has(item)) drop.run(repo, item);
  });
}

/**
 * Count this tick for each file that kept a pickup over the bound on `day`,
 * once per file; the day's counts for those files, after it.
 */
export function countHotspots(
  repo: string,
  day: string,
  previousDay: string,
  paths: readonly string[],
  root = stateRoot(),
): Map<string, number> {
  const db = stateDb(root);
  const bump = db.query(
    `INSERT INTO overlap_hotspots (repo, day, path, ticks) VALUES (?, ?, ?, 1)
     ON CONFLICT (repo, day, path) DO UPDATE SET ticks = ticks + 1`,
  );
  const read = db.query(
    "SELECT ticks FROM overlap_hotspots WHERE repo = ? AND day = ? AND path = ?",
  );
  return inTransaction(db, () => {
    db.query("DELETE FROM overlap_hotspots WHERE day < ?").run(previousDay);
    const out = new Map<string, number>();
    for (const path of new Set(paths)) {
      bump.run(repo, day, path);
      const row = read.get(repo, day, path) as { ticks: number } | null;
      out.set(path, row?.ticks ?? 1);
    }
    return out;
  });
}
