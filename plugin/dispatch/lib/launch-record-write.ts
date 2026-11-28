/** The one write transaction of a launch record and its record-reads marker. */
import type { Database } from "bun:sqlite";
import type { LaunchRecord } from "./launches.ts";

/**
 * Store a record's JSON and mark whether it validates. One write transaction:
 * no other writer can change the row between the record and its marker, and
 * the marker is set only while the stored JSON is the one this writer
 * validated. A trigger clears the marker whenever the record changes.
 */
export function upsertLaunchRecord(
  db: Database,
  record: LaunchRecord,
  text: string,
  reads: 0 | 1,
): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO launches (id, repo, action, pr, item, created_at, record, record_reads)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET record = excluded.record`,
    ).run(
      record.id,
      record.repo,
      record.action,
      record.pr,
      record.item,
      record.createdAt,
      text,
      0,
    );
    db.query(
      "UPDATE launches SET record_reads = ? WHERE id = ? AND record = ?",
    ).run(reads, record.id, text);
  }).immediate();
}
