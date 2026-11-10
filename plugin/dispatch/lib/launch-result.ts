/** A session owns its result and handoff; one conditional write settles both. */
import { Defect } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import type { PickupRefusal, SessionResult } from "./launches.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { derivedNext, type NextOwner } from "./next-owner.ts";
import { sessionResultClass } from "./session-result-class.ts";
import { inTransaction, stateDb } from "./state.ts";

/**
 * Record a session's or a follow-up pass's answer: true when this call wrote it,
 * false when the record already had one, which stands. A pickup the
 * repository's start rules refused carries its `refusal`, written with it.
 */
export function recordResult(
  id: string,
  result: SessionResult,
  root = stateRoot(),
  next: NextOwner | null = null,
  refusal: PickupRefusal | null = null,
): boolean {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const done = db
      .query(
        "UPDATE launches SET result = ?, result_at = ?, result_next = ?, refusal = ? WHERE id = ? AND result IS NULL",
      )
      .run(
        result,
        new Date().toISOString(),
        next === null ? null : JSON.stringify(next),
        refusal === null ? null : JSON.stringify(refusal),
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
      const storedExit = db
        .query("SELECT exit FROM launches WHERE id = ?")
        .get(id) as { exit: string | null };
      const exit: unknown =
        storedExit.exit === null ? null : JSON.parse(storedExit.exit);
      const placed = sessionResultClass(
        result,
        isMapping(exit) ? exit.said : undefined,
      );
      if (placed === null) throw new Defect("a recorded result must classify");
      row.class = placed.class;
      row.reason = placed.reason;
      row.next =
        row.stage === "pickup" && result === "done"
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
