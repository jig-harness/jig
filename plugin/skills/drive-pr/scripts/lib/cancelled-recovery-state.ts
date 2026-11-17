/** The durable grace period, single re-run claim and person-granted re-runs for a head. Additive SQLite state. */
import { driveDb } from "./state/db.ts";
import { canonicalPr, resolveStateDir } from "./state/store.ts";
import type { RecoveryRecord } from "./cancelled-recovery.ts";
import { labelRerunKey } from "./label-cancelled-runs.ts";
import type { WorkflowRun } from "./status/workflow-runs.ts";
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
      "SELECT first_seen, requested_at, workflow_ids, grants, grant_pending FROM cancelled_ci WHERE clone = ? AND pr = ? AND head = ?",
    )
    .get(drive.clone, canonicalPr(pr), head) as {
    first_seen: number;
    requested_at: number | null;
    workflow_ids: string;
    grants: number;
    grant_pending: number;
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
    grantPending: row.grant_pending === 1,
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
 * the head the park was framed for: a spent claim is released and the grant
 * counted, so the next recovery repeats every check the first one made (the
 * exact head and the CI hold) before it requests the re-run.
 * A claim younger than the 60-second replacement window may still be waiting
 * for its own re-run, so it is kept and the grant is recorded as pending; the
 * recovery releases it once the window passes with no replacement. `answer`
 * names the answer, so a re-arm that reads it again grants nothing more.
 * Returns how many records the answer reached.
 */
export async function grantCancellation(
  pr: string,
  head: string,
  answer: string,
): Promise<number> {
  const drive = driveDb(await resolveStateDir());
  const aged = "requested_at < ?";
  const cutoff = currentMs() - 60_000;
  return drive.db
    .query(
      `UPDATE cancelled_ci SET
         workflow_ids = CASE WHEN ${aged} THEN '[]' ELSE workflow_ids END,
         grant_pending = CASE WHEN ${aged} THEN 0 ELSE 1 END,
         requested_at = CASE WHEN ${aged} THEN NULL ELSE requested_at END,
         grants = grants + 1, granted_for = ?
       WHERE clone = ? AND pr = ? AND head = ? AND requested_at IS NOT NULL
         AND (granted_for IS NULL OR granted_for <> ?) RETURNING head`,
    )
    .all(
      cutoff,
      cutoff,
      cutoff,
      answer,
      drive.clone,
      canonicalPr(pr),
      head,
      answer,
    ).length;
}

/** Release a claim a pending grant was waiting on; true when it did. */
export async function releasePendingGrant(
  pr: string,
  head: string,
): Promise<boolean> {
  const drive = driveDb(await resolveStateDir());
  return (
    drive.db
      .query(
        "UPDATE cancelled_ci SET requested_at = NULL, workflow_ids = '[]', grant_pending = 0 WHERE clone = ? AND pr = ? AND head = ? AND grant_pending = 1 RETURNING head",
      )
      .get(drive.clone, canonicalPr(pr), head) !== null
  );
}

/** When each label-caused re-run on the pull request was requested, by run and attempt. */
export async function labelReruns(
  pr: string,
): Promise<ReadonlyMap<string, number>> {
  const drive = driveDb(await resolveStateDir());
  const rows = drive.db
    .query(
      "SELECT run_id, attempt, requested_at FROM cancelled_ci_label_rerun WHERE clone = ? AND pr = ?",
    )
    .all(drive.clone, canonicalPr(pr)) as {
    run_id: number;
    attempt: number;
    requested_at: number;
  }[];
  return new Map(
    rows.map((row) => [
      labelRerunKey({ id: row.run_id, attempt: row.attempt }),
      row.requested_at,
    ]),
  );
}

/** Claim the one re-run of a label-caused cancellation's attempt; atomic across callers. */
export async function claimLabelRerun(
  pr: string,
  run: WorkflowRun,
): Promise<boolean> {
  const drive = driveDb(await resolveStateDir());
  return (
    drive.db
      .query(
        "INSERT OR IGNORE INTO cancelled_ci_label_rerun (clone, pr, run_id, attempt, requested_at) VALUES (?, ?, ?, ?, ?) RETURNING run_id",
      )
      .get(drive.clone, canonicalPr(pr), run.id, run.attempt, currentMs()) !==
    null
  );
}
