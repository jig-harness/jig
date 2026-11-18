/**
 * A dispatched pickup's claim, recorded where it is made. `tracker.ts claim`
 * calls `notePickupClaim` once its claim has landed; in a pass the dispatcher
 * started, `JIG_LAUNCH` names the pickup's launch record, and the claimed item
 * joins that record's persisted claim set. The tick then knows the claim is its
 * pickup's however soon the pass ends after it, and whether or not a tick read
 * the item in progress while the pass ran: a served person's item in progress
 * counts as a pickup's only with that evidence (`plan-pickups.ts`).
 *
 * The same transaction writes the claim's allocation charge
 * (`allocation-store.ts`), keyed by claim id so a replay counts once, with
 * the lane the repository's newest ranking gave the item and the lane
 * weights the host's weights file holds now. The charge is written under a
 * savepoint: a charge that fails to write is rolled back alone and reported
 * beside the noted claim, which still commits.
 *
 * Outside a dispatched pickup it notes nothing: a person's own claim, a
 * drive's pass, a follow-up. The record and the acknowledgement have separate
 * writers, so a tick writing a stale record cannot erase a claim.
 */
import type { Database } from "bun:sqlite";
import { launchOf } from "../../shared/launched-session.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  readLaneWeights,
  weightsFilePath,
} from "../../shared/priorities/weights.ts";
import { currentMs } from "../../shared/time.ts";
import { stateRoot } from "../receipts.ts";
import { claimId, writeCharge } from "./allocation-store.ts";
import { holdsItem } from "./launch-pickups.ts";
import { isLaunchRecord, isRecordId, type LaunchRecord } from "./launches.ts";
import { inTransaction, stateDb } from "./state.ts";

/** Why nothing is noted outside a dispatched pass; a caller says nothing about it. */
export const NOT_DISPATCHED = "this process is no dispatched pickup";

/** Whether the claim was noted, on which record; or why this process has no pickup record to note it on. */
export type ClaimNote =
  | { noted: true; record: string; chargeFailed?: string }
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
        db.query(
          "INSERT OR IGNORE INTO pickup_claims (launch, item) VALUES (?, ?)",
        ).run(id, key);
        return { charge: chargeUnderSavepoint(db, id, key, record.repo, env) };
      });
    },
  );
  if (!written.ok) return failed("state-unwritable", written.failure.reason);
  const value = written.value;
  if (typeof value === "string") return ok({ noted: false, why: value });
  return ok({
    noted: true,
    record: id,
    ...(value.charge === null ? {} : { chargeFailed: value.charge }),
  });
}

/**
 * Write the claim's charge under a savepoint of the claim's transaction; why
 * it failed, rolled back alone, or `null` when it was written (or replayed).
 */
function chargeUnderSavepoint(
  db: Database,
  launch: string,
  key: string,
  repo: string,
  env: Record<string, string | undefined>,
): string | null {
  db.run("SAVEPOINT allocation_charge");
  const charged = attempt(
    "state-unwritable",
    `the allocation charge of ${key}`,
    () =>
      writeCharge(
        db,
        { claimId: claimId(launch, key), repo, item: key, atMs: currentMs() },
        readLaneWeights(weightsFilePath(env)),
      ),
  );
  if (!charged.ok) db.run("ROLLBACK TO allocation_charge");
  db.run("RELEASE allocation_charge");
  return charged.ok ? null : charged.failure.reason;
}

/** Why `record` takes no claim of `key`; `null` when it does. */
function refusal(record: LaunchRecord, key: string): string | null {
  if (record.action !== "pickup")
    return `launch record ${record.id} is a ${record.action}'s, not a pickup's`;
  if (!holdsItem(record, key))
    return `launch record ${record.id} no longer holds its item`;
  const members = record.batchItems?.map((i) => i.key) ?? [record.item];
  return members.includes(key)
    ? null
    : `launch record ${record.id} picks up ${members.join(", ")}, not ${key}`;
}
