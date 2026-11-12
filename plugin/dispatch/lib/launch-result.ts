/** A session owns its result and handoff; one conditional write settles both. */
import { Defect } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import type { PickupRefusal, SessionResult } from "./launches.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { derivedNext, type NextOwner } from "./next-owner.ts";
import { sessionResultClass } from "./session-result-class.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { FramedResult } from "./framed-result.ts";

/**
 * Record a session's or a follow-up pass's answer: true when this call wrote it,
 * false when the record already had one, which stands. A `waits` result
 * carries `until`: it is kept as `failed` with `until` beside it
 * (`asResult`). A pickup the repository's start rules refused carries its
 * `refusal`, written with it; a pass that stopped for a person carries the
 * decision it framed (`framed`), written with it too.
 */
export function recordResult(
  id: string,
  result: SessionResult,
  root = stateRoot(),
  next: NextOwner | null = null,
  refusal: PickupRefusal | null = null,
  until?: string,
  framed?: FramedResult,
): boolean {
  if (result === "waits" && until === undefined)
    throw new Defect("a waits result needs the time it waits until");
  const db = stateDb(root);
  const refused = refusal === null ? null : JSON.stringify(refusal);
  return inTransaction(db, () => {
    const done = db
      .query(
        "UPDATE launches SET result = ?, result_at = ?, result_next = ?, result_until = ?, refusal = ?, result_decision = ? WHERE id = ? AND result IS NULL",
      )
      .run(
        result === "waits" ? "failed" : result,
        framed?.at ?? new Date().toISOString(),
        next === null ? null : JSON.stringify(next),
        until ?? null,
        refused,
        framed === undefined ? null : JSON.stringify(framed),
        id,
      );
    if (done.changes !== 1) return false;
    reclassifyEnded(db, id, result, next);
    return true;
  });
}

/** A session can report after its process ended and the tick logged it: its ended row takes the result's class. */
function reclassifyEnded(
  db: ReturnType<typeof stateDb>,
  id: string,
  result: SessionResult,
  next: NextOwner | null,
): void {
  const stored = db
    .query("SELECT row FROM log WHERE key = ?")
    .get(`ended ${id}`) as { row: string } | null;
  const row: unknown = stored === null ? null : JSON.parse(stored.row);
  if (
    !isMapping(row) ||
    row.kind !== "ended" ||
    (row.stage !== "pickup" && row.stage !== "followup")
  )
    return;
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
    row.stage === "pickup" && (result === "done" || result === "waits")
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
