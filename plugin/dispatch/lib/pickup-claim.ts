/**
 * A dispatched pickup's claim, recorded where it is made. `tracker.ts claim`
 * calls `notePickupClaim` once its claim has landed; in a pass the dispatcher
 * started, `JIG_LAUNCH` names the pickup's launch record, and the claimed item
 * joins that record's `claimedItems`. The tick then knows the claim is its
 * pickup's however soon the pass ends after it, and whether or not a tick read
 * the item in progress while the pass ran: a served person's item in progress
 * counts as a pickup's only with that evidence (`plan-pickups.ts`).
 *
 * Outside a dispatched pickup it notes nothing: a person's own claim, a
 * drive's pass, a follow-up. The read, the merge and the write run in one
 * transaction, so a tick writing the record at the same time loses neither.
 */
import { launchOf } from "../../shared/launched-session.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { stateRoot } from "../receipts.ts";
import { isLaunchRecord, isRecordId, type LaunchRecord } from "./launches.ts";
import { inTransaction, stateDb } from "./state.ts";

/** Why nothing is noted outside a dispatched pass; a caller says nothing about it. */
export const NOT_DISPATCHED = "this process is no dispatched pickup";

/** Whether the claim was noted, on which record; or why this process has no pickup record to note it on. */
export type ClaimNote =
  | { noted: true; record: string }
  | { noted: false; why: string };

/** Note `key`'s claim on the pickup record this process runs under. */
export function notePickupClaim(
  key: string,
  env: Record<string, string | undefined> = process.env,
  root = stateRoot(),
): Outcome<ClaimNote, "state-unwritable"> {
  const id = launchOf(env);
  if (id === null || !isRecordId(id))
    return ok({ noted: false, why: NOT_DISPATCHED });
  const written = attempt(
    "state-unwritable",
    `the claim of ${key} on launch record ${id}`,
    () => {
      const db = stateDb(root);
      return inTransaction(db, () => {
        const row = db
          .query("SELECT record FROM launches WHERE id = ?")
          .get(id) as { record: string } | null;
        if (row === null) return `launch record ${id} is not on this host`;
        const record: unknown = JSON.parse(row.record);
        if (!isLaunchRecord(record) || record.id !== id)
          return `launch record ${id} does not read`;
        const why = refusal(record, key);
        if (why !== null) return why;
        const claimed = new Set(record.claimedItems ?? []);
        if (claimed.has(key)) return null;
        claimed.add(key);
        record.claimedItems = [...claimed];
        db.query("UPDATE launches SET record = ? WHERE id = ?").run(
          JSON.stringify(record),
          id,
        );
        return null;
      });
    },
  );
  if (!written.ok) return failed("state-unwritable", written.failure.reason);
  return ok(
    written.value === null
      ? { noted: true, record: id }
      : { noted: false, why: written.value },
  );
}

/** Why `record` takes no claim of `key`; `null` when it does. */
function refusal(record: LaunchRecord, key: string): string | null {
  if (record.action !== "pickup")
    return `launch record ${record.id} is a ${record.action}'s, not a pickup's`;
  if (record.released)
    return `launch record ${record.id} no longer holds its item`;
  const members = record.batchItems?.map((i) => i.key) ?? [record.item];
  return members.includes(key)
    ? null
    : `launch record ${record.id} picks up ${members.join(", ")}, not ${key}`;
}
