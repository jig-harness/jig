/** A pickup's dependency and its waiting result are stored in one transaction. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { Defect } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import { type LaunchRecord, type LaunchRow, recordOf } from "./launches.ts";
import { holdsItem, pickupItems } from "./launch-pickups.ts";
import type { NextOwner } from "./next-owner.ts";
import { inTransaction, stateDb } from "./state.ts";
import {
  dropClearedPickupHold,
  insertPickupHold,
  type PersonPickupHold,
} from "./person-pickup-holds.ts";
import { writeResult } from "./launch-result.ts";

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
