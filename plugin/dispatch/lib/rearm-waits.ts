import { currentMs } from "../../shared/time.ts";
import { stateDb } from "./state.ts";

type WaitKind = "tree" | "stop" | "capacity";

export interface RearmWait {
  repo: string;
  pr: number;
  request: number;
  kind: WaitKind;
}

/** Retain the first observation of this request's current confirmed blocker. */
export function rearmWaitAge(
  wait: RearmWait,
  reason: string,
  root?: string,
): number {
  const now = currentMs();
  const row = stateDb(root)
    .query<
      { since_ms: number },
      [string, number, number, WaitKind, string, number]
    >(
      `INSERT INTO rearm_waits (repo, pr, request_id, kind, reason, since_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, pr) DO UPDATE SET
       request_id = excluded.request_id,
       kind = excluded.kind,
       reason = excluded.reason,
       since_ms = CASE
         WHEN rearm_waits.request_id = excluded.request_id
           AND rearm_waits.kind = excluded.kind AND rearm_waits.reason = excluded.reason
         THEN rearm_waits.since_ms ELSE excluded.since_ms END
     RETURNING since_ms`,
    )
    .get(wait.repo, wait.pr, wait.request, wait.kind, reason, now);
  return now - (row?.since_ms ?? now);
}

export function clearRearmWait(wait: RearmWait, root?: string): void {
  stateDb(root)
    .query(
      `DELETE FROM rearm_waits WHERE repo = ? AND pr = ?
     AND request_id = ? AND kind = ?`,
    )
    .run(wait.repo, wait.pr, wait.request, wait.kind);
}

export function clearRearmRequest(
  repo: string,
  pr: number,
  request: number,
  root?: string,
): void {
  stateDb(root)
    .query(
      "DELETE FROM rearm_waits WHERE repo = ? AND pr = ? AND request_id = ?",
    )
    .run(repo, pr, request);
}
