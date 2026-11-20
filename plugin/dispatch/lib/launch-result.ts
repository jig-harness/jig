/** A session owns its result and handoff; one conditional write settles both. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { Defect } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import {
  type LaunchRecord,
  type LaunchRow,
  type PickupRefusal,
  recordOf,
} from "./launches.ts";
import type { SessionResult } from "./session-result-types.ts";
import { holdsItem, pickupItems } from "./launch-pickups.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { endedNext, type NextOwner } from "./next-owner.ts";
import { sessionResultClass } from "./session-result-class.ts";
import { inTransaction, stateDb } from "./state.ts";
import { type FramedResult, readFramedResult } from "./framed-result.ts";
import { storedEndedRow } from "./closing-report-store.ts";
import { currentIso, parseMs } from "../../shared/time.ts";
import { testLockNote } from "./test-lock-note.ts";
import {
  dropClearedPickupHold,
  insertPickupHold,
  type PersonPickupHold,
} from "./person-pickup-holds.ts";
import { RATE_LIMIT_WAIT, readWaitFor, type WaitFor } from "./wait-for.ts";

/**
 * A row's answer as every reader takes it. Storage knows only `done` and
 * `failed`: a `waits` result is kept as `failed` with the time in
 * `result_until`, and a `parked` one, a pass that stopped on the decision it
 * framed for a person, as `failed` with that decision in `result_decision`.
 * A copy of the plugin that knows neither reads a failed pass, which it
 * holds until a person settles it rather than starting it again; this one
 * reads each apart from a failure, launch records written before it knew
 * them included. An outcome row already logged keeps the class it was
 * logged with. `failed` stays for a pass that recorded it with no wait and no
 * framed decision, and for a row whose `result_until` is not a time or
 * whose `result_decision` is not a readable decision.
 */
export function asResult(
  value: string | null,
  until: string | null = null,
  decision: string | null = null,
  wait: string | null = null,
): SessionResult | null {
  if (
    value === "failed" &&
    ((until !== null && !Number.isNaN(parseMs(until))) ||
      readWaitFor(wait).condition !== undefined)
  )
    return "waits";
  if (value === "failed" && readFramedResult(decision) !== null)
    return "parked";
  return value === "done" || value === "failed" ? value : null;
}

export function rowResult(
  row: Pick<
    LaunchRow,
    "result" | "result_until" | "result_decision" | "result_wait"
  >,
): SessionResult | null {
  return asResult(
    row.result,
    row.result_until,
    row.result_decision,
    row.result_wait,
  );
}

/** A record's recorded answer; `null` when none. */
export function readResult(
  id: string,
  root = stateRoot(),
): SessionResult | null {
  const row = stateDb(root)
    .query(
      "SELECT result, result_until, result_decision, result_wait FROM launches WHERE id = ?",
    )
    .get(id) as {
    result: string | null;
    result_until: string | null;
    result_decision: string | null;
    result_wait: string | null;
  } | null;
  return asResult(
    row?.result ?? null,
    row?.result_until ?? null,
    row?.result_decision ?? null,
    row?.result_wait ?? null,
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
  const db = stateDb(root);
  return inTransaction(db, () =>
    writeResult(db, id, { result, next, refusal, until, wait, framed }),
  );
}

/** Store a pickup's dependency and its result together, preserving an existing hold. */
export function recordConditionalResult(
  launch: Pick<LaunchRecord, "id" | "token">,
  item: string,
  hold: Omit<PersonPickupHold, "item" | "at">,
  next: NextOwner,
  root = stateRoot(),
): Outcome<boolean, "refused"> {
  const condition = hold.condition;
  if (condition === undefined)
    throw new Defect("a conditional result needs a pickup dependency");
  const db = stateDb(root);
  return inTransaction(db, () => {
    const own = pickupForConditionalResult(db, root, launch, item);
    if (!own.ok) return own;
    if (own.value === null) return ok(false);
    const { repo, createdAt } = own.value;
    dropClearedPickupHold(db, repo, item, createdAt);
    if (!insertPickupHold(db, repo, item, hold))
      return failed(
        "refused",
        `${item} already has a different pickup hold; its original hold stands`,
      );
    const wrote = writeResult(db, launch.id, {
      result: "waits",
      next,
      refusal: null,
      until: undefined,
      wait: { reason: "pickup-condition", condition },
      framed: undefined,
    });
    if (!wrote)
      throw new Defect(
        "the pickup result changed within its write transaction",
      );
    return ok(wrote);
  });
}

/** Take ownership from the transaction's current records, including batch members. */
function pickupForConditionalResult(
  db: ReturnType<typeof stateDb>,
  root: string,
  launch: Pick<LaunchRecord, "id" | "token">,
  item: string,
): Outcome<LaunchRecord | null, "refused"> {
  const own = db
    .query("SELECT *, rowid AS ordinal FROM launches WHERE id = ?")
    .get(launch.id) as (LaunchRow & { ordinal: number }) | null;
  if (own === null)
    return failed(
      "refused",
      `pickup ${launch.id} no longer has a launch record`,
    );
  if (own.result !== null) return ok(null);
  const record = recordOf(own, root, new Map(), db);
  if (
    record === null ||
    record.action !== "pickup" ||
    record.cancelledAt !== undefined ||
    record.token !== launch.token ||
    record.item !== item ||
    record.batchItems !== undefined ||
    !holdsItem(record, item)
  )
    return failed("refused", `pickup ${launch.id} no longer holds ${item}`);

  const later = db
    .query(
      `SELECT * FROM launches
       WHERE repo = ? AND action = 'pickup'
       AND (created_at > ? OR (created_at = ? AND rowid > ?))
       AND (item = ? OR EXISTS (
         SELECT 1 FROM json_each(launches.record, '$.batchItems') AS member
           WHERE json_extract(member.value, '$.key') = ?
       ))`,
    )
    .all(
      record.repo,
      record.createdAt,
      record.createdAt,
      own.ordinal,
      item,
      item,
    ) as LaunchRow[];
  for (const row of later) {
    const successor = recordOf(row, root, new Map(), db);
    if (successor === null)
      return failed(
        "refused",
        `could not verify whether pickup ${row.id} superseded ${launch.id}`,
      );
    if (
      successor.cancelledAt === undefined &&
      pickupItems(successor).includes(item) &&
      holdsItem(successor, item)
    )
      return failed(
        "refused",
        `pickup ${successor.id} superseded ${launch.id} for ${item}`,
      );
  }
  return ok(record);
}

function writeResult(
  db: ReturnType<typeof stateDb>,
  id: string,
  fields: Recorded & {
    refusal: PickupRefusal | null;
    until: string | undefined;
  },
): boolean {
  const { result, next, refusal, until, framed, wait } = fields;
  const done = db
    .query(
      "UPDATE launches SET result = ?, result_at = ?, result_next = ?, result_until = ?, refusal = ?, result_decision = ?, result_wait = ? WHERE id = ? AND result IS NULL",
    )
    .run(
      storedResult(result),
      framed?.at ?? currentIso(),
      next === null ? null : JSON.stringify(next),
      until ?? null,
      refusal === null ? null : JSON.stringify(refusal),
      framed === undefined ? null : JSON.stringify(framed),
      result === "waits" ? JSON.stringify(wait) : null,
      id,
    );
  if (done.changes !== 1) return false;
  const read = result === "failed" && framed !== undefined ? "parked" : result;
  reclassifyEnded(db, id, { result: read, next, wait, framed });
  return true;
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
