/**
 * The morning report's reader of the launch records. One rule: the report
 * lists every launch record with a dispatched mark created in its window,
 * by the indexed creation time, and says for each how its launch went. No
 * record is filtered out by launch evidence, and none is selected by the
 * times of its attempts or claim: a replay of an older record is the same
 * launch, listed by the night the launch was recorded.
 */
import {
  claimOf,
  type LaunchRecord,
  type LaunchRow,
  type LaunchClaim,
  recordOf,
} from "./launches.ts";
import { stateRoot } from "../receipts.ts";
import { existingStateDb, statePath } from "./state.ts";
import { isoFromMs } from "../../shared/time.ts";

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
  claim: LaunchClaim | null | undefined,
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

/**
 * Every record with a dispatched mark created at or after `since`
 * (milliseconds), oldest first, with how its launch went, for a reader that
 * never creates the database. A row that does not read, and a claim that
 * does not read, are named; the claim then proves nothing.
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
  const all = db
    .query(
      "SELECT id, record, claim, exit, result FROM launches WHERE created_at >= ?1 ORDER BY id",
    )
    .all(isoFromMs(since)) as LaunchRow[];
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
    if (record.mark)
      records.push({ record, launch: launchSeen(record, claim) });
  }
  return { records, unreadable };
}
