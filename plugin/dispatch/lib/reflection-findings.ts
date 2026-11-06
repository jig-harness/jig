/**
 * The findings the reflection route (`reflection-route.ts`) made of the
 * classes that recur, one row each in the state database's
 * `reflection_findings` table under the finding's id, which is derived from
 * the repository, the stage, the class and the week. A row holds the event as
 * its first append sent it, so every retry sends the same bytes and a store
 * that kept an earlier copy holds one event, not two. It is pending until the
 * store reports it stored; a later tick that finds the same recurrence in the
 * same week finds its row and records nothing. Nothing removes a row: there is
 * one per recurring class per week.
 */
import type { Database } from "bun:sqlite";

export interface FindingRecord {
  id: string;
  repo: string;
  stage: string;
  class: string;
  /** The host-time ISO week it was found in: `2026-W45`. */
  week: string;
  /** The finding event as one line of JSON, sent as it is on every append. */
  event: string;
  /** When a tick first found it. */
  at: string;
  /** When the store reported it stored; `null` while it is pending. */
  storedAt: string | null;
  /** Where the store said it keeps it, when it said. */
  ref: string | null;
}

interface Row {
  id: string;
  repo: string;
  stage: string;
  class: string;
  week: string;
  event: string;
  at: string;
  stored_at: string | null;
  ref: string | null;
}

function recordOf(row: Row): FindingRecord {
  return {
    id: row.id,
    repo: row.repo,
    stage: row.stage,
    class: row.class,
    week: row.week,
    event: row.event,
    at: row.at,
    storedAt: row.stored_at,
    ref: row.ref,
  };
}

/** Whether a finding with this id was found before, stored or not. */
export function hasFinding(db: Database, id: string): boolean {
  return (
    db.query("SELECT 1 FROM reflection_findings WHERE id = ?").get(id) !== null
  );
}

/** Keep a finding a tick found, pending; false when a row with its id is already there. */
export function addFinding(
  db: Database,
  record: Omit<FindingRecord, "storedAt" | "ref">,
): boolean {
  return (
    db
      .query(
        `INSERT INTO reflection_findings (id, repo, stage, class, week, event, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        record.id,
        record.repo,
        record.stage,
        record.class,
        record.week,
        record.event,
        record.at,
      ).changes === 1
  );
}

/** The findings of `repo` the store has not reported stored, oldest first. */
export function pendingFindings(db: Database, repo: string): FindingRecord[] {
  return (
    db
      .query(
        "SELECT * FROM reflection_findings WHERE repo = ? AND stored_at IS NULL ORDER BY at, id",
      )
      .all(repo) as Row[]
  ).map(recordOf);
}

/** Mark a finding stored, once. */
export function markStored(
  db: Database,
  id: string,
  at: string,
  ref: string | null,
): void {
  db.query(
    "UPDATE reflection_findings SET stored_at = ?, ref = ? WHERE id = ? AND stored_at IS NULL",
  ).run(at, ref, id);
}
