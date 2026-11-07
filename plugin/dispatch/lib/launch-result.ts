/** A session owns its result and handoff; one conditional write settles both. */
import { stateRoot } from "../receipts.ts";
import type { SessionResult } from "./launches.ts";
import type { NextOwner } from "./next-owner.ts";
import { stateDb } from "./state.ts";

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
  const done = stateDb(root)
    .query(
      "UPDATE launches SET result = ?, result_at = ?, result_next = ? WHERE id = ? AND result IS NULL",
    )
    .run(
      result,
      new Date().toISOString(),
      next === null ? null : JSON.stringify(next),
      id,
    );
  return done.changes === 1;
}
