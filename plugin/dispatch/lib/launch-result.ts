/** A session owns its result and handoff; one conditional write settles both. */
import { stateRoot } from "../receipts.ts";
import type { SessionResult } from "./launches.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { derivedNext, type NextOwner } from "./next-owner.ts";
import { inTransaction, stateDb } from "./state.ts";

/**
 * Record a session's or a follow-up pass's answer: true when this call wrote it,
 * false when the record already had one, which stands.
 */
export function recordResult(
  id: string,
  result: SessionResult,
  root = stateRoot(),
  next: NextOwner | null = null,
): boolean {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const done = db
      .query(
        "UPDATE launches SET result = ?, result_at = ?, result_next = ? WHERE id = ? AND result IS NULL",
      )
      .run(
        result,
        new Date().toISOString(),
        next === null ? null : JSON.stringify(next),
        id,
      );
    if (done.changes !== 1) return false;
    // A session can report after its process ended and the tick logged it.
    const stored = db
      .query("SELECT row FROM log WHERE key = ?")
      .get(`ended ${id}`) as { row: string } | null;
    const row: unknown = stored === null ? null : JSON.parse(stored.row);
    if (
      isMapping(row) &&
      row.kind === "ended" &&
      (row.stage === "pickup" || row.stage === "followup")
    ) {
      row.class = result === "done" ? "converged" : "gates failed";
      row.reason = `result ${result}`;
      row.next =
        row.stage === "pickup" && result === "done" && next !== null
          ? next
          : derivedNext(row.stage, String(row.class), String(row.reason));
      db.query(
        "UPDATE log SET seq = (SELECT MAX(seq) + 1 FROM log), bucket = ?, reason = ?, row = ? WHERE key = ?",
      ).run(
        String(row.class),
        String(row.reason),
        JSON.stringify(row),
        `ended ${id}`,
      );
    }
    return true;
  });
}
