/** The durable grace period, single re-run claim and person-granted re-runs for a head. Additive SQLite state. */
import { driveDb } from "./state/db.ts";
import { canonicalPr, resolveStateDir } from "./state/store.ts";
import type { RecoveryRecord } from "./cancelled-recovery.ts";
import { fail } from "./cli.ts";
import { currentMs } from "../../../../shared/time.ts";

export async function observeCancellation(
  pr: string,
  head: string,
): Promise<RecoveryRecord> {
  const drive = driveDb(await resolveStateDir());
  drive.db.run(
    "INSERT OR IGNORE INTO cancelled_ci (clone, pr, head, first_seen, requested_at) VALUES (?, ?, ?, ?, NULL)",
    [drive.clone, canonicalPr(pr), head, currentMs()],
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
      "SELECT first_seen, requested_at, workflow_ids, grants FROM cancelled_ci WHERE clone = ? AND pr = ? AND head = ?",
    )
    .get(drive.clone, canonicalPr(pr), head) as {
    first_seen: number;
    requested_at: number | null;
    workflow_ids: string;
    grants: number;
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
    grants: row.grants,
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
        currentMs(),
        JSON.stringify(workflowIds),
        drive.clone,
        canonicalPr(pr),
        head,
      ) !== null
  );
}

/**
 * A person's answer to the `cancelled-ci` park authorises one more re-run on
 * each head the pull request has a spent recovery record for: the claim is
 * released and the grant counted, so the next recovery repeats every check
 * the first one made (the exact head, the CI hold, the run's event) before it
 * requests the re-run. `answer` names the answer, so a re-arm that reads it
 * again grants nothing more; a claim younger than the 60-second replacement
 * window is still waiting for its own re-run and is left alone. Returns how
 * many heads it released.
 */
export async function grantCancellation(
  pr: string,
  answer: string,
): Promise<number> {
  const drive = driveDb(await resolveStateDir());
  return drive.db
    .query(
      "UPDATE cancelled_ci SET requested_at = NULL, workflow_ids = '[]', grants = grants + 1, granted_for = ? WHERE clone = ? AND pr = ? AND requested_at IS NOT NULL AND requested_at < ? AND (granted_for IS NULL OR granted_for <> ?) RETURNING head",
    )
    .all(answer, drive.clone, canonicalPr(pr), currentMs() - 60_000, answer)
    .length;
}
