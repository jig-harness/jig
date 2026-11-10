/** A steward recovery repeated in a week proposes replacing judgment with a checked rule. */
import type { Database } from "bun:sqlite";
import type { RecurringClass } from "./dashboard-contract.ts";

export function stewardRecurrences(
  db: Database,
  repo: string,
  nowMs: number,
): RecurringClass[] {
  const rows = db
    .query(`SELECT json_extract(r.value, '$.class') AS class, COUNT(*) AS n
    FROM steward_records r JOIN steward_runs s ON s.id = r.run
    WHERE r.repo = ? AND r.effect IS NOT NULL AND r.effect != 'refused' AND json_extract(r.value, '$.kind') = 'rearm'
      AND r.effect_at_ms > ? AND r.effect_at_ms <= ? GROUP BY class HAVING COUNT(*) >= 3`)
    .all(repo, nowMs - 7 * 86_400_000, nowMs) as Array<{
    class: string;
    n: number;
  }>;
  return rows.map((r) => ({
    repo,
    stage: "steward",
    class: r.class,
    rows: r.n,
    nights: [],
  }));
}
