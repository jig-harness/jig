/** A session owns its result and handoff; one conditional write settles both. */
import { Defect } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import type { PickupRefusal, SessionResult } from "./launches.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { endedNext, type NextOwner } from "./next-owner.ts";
import { sessionResultClass } from "./session-result-class.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { FramedResult } from "./framed-result.ts";
import { storedEndedRow } from "./closing-report-store.ts";
import { currentIso } from "../../shared/time.ts";
import { testLockNote } from "./test-lock-note.ts";
import { RATE_LIMIT_WAIT, type WaitFor } from "./wait-for.ts";

/**
 * A row's answer as every reader takes it. Storage knows only `done` and
 * `failed`: a `waits` result is kept as `failed` with the time in
 * `result_until`, and a `parked` one, a pass that stopped on the decision it
 * framed for a person, as `failed` with that decision in `result_decision`.
 * A copy of the plugin that knows neither reads a failed pass, which it
 * holds until a person settles it rather than starting it again; this one
 * reads each apart from a failure, rows written before it knew them
 * included. `failed` stays for a pass that recorded it with no wait and no
 * framed decision.
 */
export function asResult(
  value: string | null,
  until: string | null = null,
  decision: string | null = null,
): SessionResult | null {
  if (value === "failed" && until !== null) return "waits";
  if (value === "failed" && decision !== null) return "parked";
  return value === "done" || value === "failed" ? value : null;
}

/** A record's recorded answer; `null` when none. */
export function readResult(
  id: string,
  root = stateRoot(),
): SessionResult | null {
  const row = stateDb(root)
    .query(
      "SELECT result, result_until, result_decision FROM launches WHERE id = ?",
    )
    .get(id) as {
    result: string | null;
    result_until: string | null;
    result_decision: string | null;
  } | null;
  return asResult(
    row?.result ?? null,
    row?.result_until ?? null,
    row?.result_decision ?? null,
  );
}

/** How a result is kept: `waits` and `parked` as `failed`, beside what tells them apart (`asResult`). */
function storedResult(result: SessionResult): "done" | "failed" {
  return result === "done" ? "done" : "failed";
}

/**
 * Record a session's or a follow-up pass's answer: true when this call wrote it,
 * false when the record already had one, which stands. A `waits` result
 * carries `until`: it is kept as `failed` with `until` beside it
 * (`asResult`), and what it waits for (`wait`, a rate limit's reset when
 * absent). A pickup the repository's start rules refused carries its
 * `refusal`, written with it. A `parked` result, a pass that stopped for a
 * person, carries the decision it framed (`framed`), kept as `failed` with
 * the decision beside it.
 */
export function recordResult(
  id: string,
  result: SessionResult,
  root = stateRoot(),
  next: NextOwner | null = null,
  refusal: PickupRefusal | null = null,
  until?: string,
  framed?: FramedResult,
  wait: WaitFor = RATE_LIMIT_WAIT,
): boolean {
  if (result === "waits" && until === undefined)
    throw new Defect("a waits result needs the time it waits until");
  if (result === "parked" && framed === undefined)
    throw new Defect("a parked result needs the decision it framed");
  // A failed pass that carries a framed decision is kept, and so read, as parked.
  const read = result === "failed" && framed !== undefined ? "parked" : result;
  const db = stateDb(root);
  const refused = refusal === null ? null : JSON.stringify(refusal);
  return inTransaction(db, () => {
    const done = db
      .query(
        "UPDATE launches SET result = ?, result_at = ?, result_next = ?, result_until = ?, refusal = ?, result_decision = ?, result_wait = ? WHERE id = ? AND result IS NULL",
      )
      .run(
        storedResult(result),
        framed?.at ?? currentIso(),
        next === null ? null : JSON.stringify(next),
        until ?? null,
        refused,
        framed === undefined ? null : JSON.stringify(framed),
        result === "waits" ? JSON.stringify(wait) : null,
        id,
      );
    if (done.changes !== 1) return false;
    reclassifyEnded(db, id, { result: read, next, wait, framed });
    return true;
  });
}

/** What a session recorded, as its ended row is classed from it. */
interface Recorded {
  result: SessionResult;
  next: NextOwner | null;
  wait: WaitFor;
  framed: FramedResult | undefined;
}

/** A session can report after its process ended and the tick logged it: its ended row takes the result's class. */
function reclassifyEnded(
  db: ReturnType<typeof stateDb>,
  id: string,
  recorded: Recorded,
): void {
  const row = storedEndedRow(db, id);
  if (row === null || (row.stage !== "pickup" && row.stage !== "followup"))
    return;
  const storedExit = db
    .query("SELECT exit, record FROM launches WHERE id = ?")
    .get(id) as { exit: string | null; record: string };
  const exit: unknown =
    storedExit.exit === null ? null : JSON.parse(storedExit.exit);
  const placed = sessionResultClass(
    recorded.result,
    isMapping(exit) ? exit.said : undefined,
    recorded.wait,
    recorded.framed,
  );
  if (placed === null) throw new Defect("a recorded result must classify");
  // The ended row named the last wait for the test lock; the new reason keeps it.
  const wait = testLockNote(JSON.parse(storedExit.record), undefined, true);
  row.class = placed.class;
  row.reason = wait === null ? placed.reason : `${placed.reason}; ${wait}`;
  row.next = endedNext(row.stage, {
    ...recorded,
    class: String(row.class),
    reason: String(row.reason),
  });
  db.query(
    "UPDATE log SET seq = (SELECT MAX(seq) + 1 FROM log), bucket = ?, reason = ?, row = ? WHERE key = ?",
  ).run(
    String(row.class),
    String(row.reason),
    JSON.stringify(row),
    `ended ${id}`,
  );
}
