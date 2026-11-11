/** Read claims recorded at the pickup boundary without changing tick-owned JSON. */
import type { Database } from "bun:sqlite";

/** Claimed item keys for `launch`, ordered for deterministic launch reads. */
export function pickupClaims(launch: string, db: Database): string[] {
  const table = db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pickup_claims'",
    )
    .get();
  if (table === null) return [];
  return db
    .query("SELECT item FROM pickup_claims WHERE launch = ? ORDER BY item")
    .all(launch)
    .map((row) => (row as { item: string }).item);
}
