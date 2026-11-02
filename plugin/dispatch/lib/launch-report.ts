/** The morning report's reader of the launch records: which marked launches were worked in a window, and how each went. */
import {
  claimOf,
  type LaunchRecord,
  type LaunchRow,
  type ProcessIdentity,
  recordOf,
} from "./launches.ts";
import { stateRoot } from "../receipts.ts";
import { existingStateDb, statePath } from "./state.ts";

/**
 * How a record's launch went, as far as the record says: `started` when the
 * runtime answered that it started the session or the wrapper claimed the
 * record (the wrapper ran, though the tick may have died before it saved
 * the answer); `lost` when an answer was lost and nothing shows the wrapper
 * ran; `not started` otherwise (no launch was called, or the runtime
 * answered that it started nothing).
 */
export type LaunchSeen = "started" | "lost" | "not started";

function launchSeen(
  record: LaunchRecord,
  claim: ProcessIdentity | null | undefined,
): LaunchSeen {
  if (
    (claim !== undefined && claim !== null) ||
    record.attempts.some((a) => a.outcome === "sent")
  )
    return "started";
  return record.attempts.some((a) => a.outcome === "lost")
    ? "lost"
    : "not started";
}

/** The latest time the record says its launch was worked: its creation, an attempt, its claim. */
function activeAt(
  record: LaunchRecord,
  claim: ProcessIdentity | null | undefined,
): number {
  const times = [
    record.createdAt,
    ...record.attempts.map((a) => a.at),
    ...(claim ? [claim.claimedAt] : []),
  ].map((t) => Date.parse(t));
  return Math.max(...times.filter((t) => !Number.isNaN(t)), 0);
}

/**
 * Every record with a dispatched mark whose launch was worked at or after
 * `since` (milliseconds), oldest first, with how its launch went, for a
 * reader that never creates the database. A launch is worked when the record
 * is written, when an attempt is made (a replay of an older record) and when
 * its wrapper claims it. A row that does not read, and a claim that does not
 * read, are named; the claim then proves nothing. No record is left out for
 * how its launch went: the reader says it.
 */
export function markedSince(
  since: number,
  root = stateRoot(),
): {
  records: Array<{ record: LaunchRecord; launch: LaunchSeen }>;
  unreadable: string[];
} {
  const db = existingStateDb(root);
  if (db === null) return { records: [], unreadable: [] };
  const from = new Date(since).toISOString();
  // The creation time is indexed; an attempt or a claim is read from its JSON.
  const all = db
    .query(
      `SELECT id, record, claim, exit, result FROM launches
       WHERE created_at >= ?1
          OR (CASE WHEN json_valid(record) THEN EXISTS (
                SELECT 1 FROM json_each(record, '$.attempts')
                WHERE json_extract(value, '$.at') >= ?1) ELSE 0 END)
          OR (claim IS NOT NULL AND CASE WHEN json_valid(claim)
                THEN json_extract(claim, '$.claimedAt') >= ?1 ELSE 0 END)
       ORDER BY id`,
    )
    .all(from) as LaunchRow[];
  const records: Array<{ record: LaunchRecord; launch: LaunchSeen }> = [];
  const unreadable: string[] = [];
  for (const row of all) {
    const record = recordOf(row, root, new Map());
    if (record === null) {
      unreadable.push(`launch record ${row.id} in ${statePath(root)}`);
      continue;
    }
    const claim = claimOf(row);
    if (claim === null)
      unreadable.push(
        `the claim of launch record ${row.id} in ${statePath(root)}`,
      );
    if (record.mark && activeAt(record, claim) >= since)
      records.push({ record, launch: launchSeen(record, claim) });
  }
  return { records, unreadable };
}
