/** The durable grace period and single re-run claim for a head. Additive SQLite state. */
import { driveDb } from "./state/db.ts";
import { canonicalPr, resolveStateDir } from "./state/store.ts";
import type { RecoveryRecord } from "./cancelled-recovery.ts";
import { fail } from "./cli.ts";

export async function observeCancellation(
  pr: string,
  head: string,
): Promise<RecoveryRecord> {
  const drive = driveDb(await resolveStateDir());
  drive.db.run(
    "INSERT OR IGNORE INTO cancelled_ci (clone, pr, head, first_seen, requested_at) VALUES (?, ?, ?, ?, NULL)",
    [drive.clone, canonicalPr(pr), head, Date.now()],
  );
  const record = await readCancellation(pr, head);
  if (record === null)
    fail(1, "cancelled CI recovery: observation disappeared");
  return record;
}

/** Observe an existing recovery without starting a grace period on healthy CI. */
export async function readCancellation(
  pr: string,
  head: string,
): Promise<RecoveryRecord | null> {
  const drive = driveDb(await resolveStateDir());
  const row = drive.db
    .query(
      "SELECT first_seen, requested_at, workflow_ids FROM cancelled_ci WHERE clone = ? AND pr = ? AND head = ?",
    )
    .get(drive.clone, canonicalPr(pr), head) as {
    first_seen: number;
    requested_at: number | null;
    workflow_ids: string;
  } | null;
  if (row === null) return null;
  const workflowIds: unknown = JSON.parse(row.workflow_ids);
  if (
    !Array.isArray(workflowIds) ||
    !workflowIds.every((id) => Number.isSafeInteger(id) && id > 0)
  )
    fail(1, "cancelled CI recovery: stored workflow identities are unreadable");
  return {
    firstSeen: row.first_seen,
    requestedAt: row.requested_at,
    workflowIds,
  };
}

/** Atomic even when two callers observed the same unclaimed row. */
export async function claimCancellation(
  pr: string,
  head: string,
  workflowIds: readonly number[] = [],
): Promise<boolean> {
  const drive = driveDb(await resolveStateDir());
  return (
    drive.db
      .query(
        "UPDATE cancelled_ci SET requested_at = ?, workflow_ids = ? WHERE clone = ? AND pr = ? AND head = ? AND requested_at IS NULL RETURNING head",
      )
      .get(
        Date.now(),
        JSON.stringify(workflowIds),
        drive.clone,
        canonicalPr(pr),
        head,
      ) !== null
  );
}
