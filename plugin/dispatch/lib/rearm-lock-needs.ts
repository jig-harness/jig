/** A refused operator rearm is visible on the line while its stopped ledger stands. */
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import { rearmLockNotice } from "./notices.ts";
import { existingStateDb, readOnlyStateDb, stateDb } from "./state.ts";
import type { Action, DrivenPr } from "./types.ts";

interface LockNeed {
  pr: number;
  generation: number;
  heartbeat: string;
  reason: string;
}

/** Keep one need per pull request; a readable lock clears the matching refusal. */
export function recordRearmLockRead(
  repo: string,
  pr: number,
  generation: number,
  heartbeat: string,
  reason: string | null,
  root = stateRoot(),
): void {
  if (reason === null) {
    existingStateDb(root)
      ?.query(
        `DELETE FROM rearm_lock_needs WHERE repo = ? AND pr = ?
       AND (generation < ? OR (generation = ? AND heartbeat <= ?))`,
      )
      .run(repo.toLowerCase(), pr, generation, generation, heartbeat);
    return;
  }
  stateDb(root)
    .query(
      `INSERT INTO rearm_lock_needs (repo, pr, generation, heartbeat, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo, pr) DO UPDATE SET generation = excluded.generation,
       heartbeat = excluded.heartbeat, reason = excluded.reason
     WHERE excluded.generation > rearm_lock_needs.generation
       OR (excluded.generation = rearm_lock_needs.generation
           AND excluded.heartbeat >= rearm_lock_needs.heartbeat)`,
    )
    .run(
      repo.toLowerCase(),
      pr,
      generation,
      heartbeat,
      reason.replace(/\s+/g, " ").slice(0, 600),
    );
}

/** A plan reads the record without creating or migrating a database. */
function readNeeds(repo: string, root: string): LockNeed[] {
  const opened = readOnlyStateDb(root);
  if (!opened.ok) {
    swallow(
      opened.failure.cause ?? opened.failure.reason,
      "the tick can proceed when the local rearm lock needs could not be read",
    );
    return [];
  }
  if (opened.value === null) return [];
  const { db } = opened.value;
  try {
    if (
      db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("rearm_lock_needs") === null
    )
      return [];
    return db
      .query(
        "SELECT pr, generation, heartbeat, reason FROM rearm_lock_needs WHERE repo = ?",
      )
      .all(repo.toLowerCase()) as LockNeed[];
  } catch (error) {
    swallow(error, "the tick can proceed without the unread rearm lock needs");
    return [];
  } finally {
    db.close();
  }
}

/** Only a current stopped ledger can still need investigation of this refusal. */
export function rearmLockNeeds(
  repo: string,
  drives: readonly DrivenPr[],
  root = stateRoot(),
): Action[] {
  const needs = readNeeds(repo, root);
  const byNumber = new Map(drives.map((drive) => [drive.number, drive]));
  return needs.flatMap((need) => {
    const drive = byNumber.get(need.pr);
    if (
      drive === undefined ||
      drive.evidence.driver !== "stopped" ||
      drive.evidence.generation !== need.generation ||
      drive.evidence.heartbeat !== need.heartbeat
    )
      return [];
    const reason = `Rearm refused because the driver lock could not be read: ${need.reason}`;
    return [
      {
        stage: "notify",
        cause: "needs-person",
        target: `PR #${need.pr}`,
        record: "runtime",
        reason,
        evidence: {
          generation: need.generation,
          heartbeat: need.heartbeat,
          rearmLockUnread: true,
          stewardAct: "Investigate",
        },
        notice: rearmLockNotice(repo, drive, need.heartbeat, reason),
      } satisfies Action,
    ];
  });
}
