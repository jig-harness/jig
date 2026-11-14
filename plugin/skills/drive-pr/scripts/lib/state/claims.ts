/**
 * Per-item claims: who may DISPATCH the external mutation for a held item,
 * and who holds the draft→Ready transition.
 *
 * `hold`/`held`/`release-held` serialise the drive state, but say nothing
 * about who may dispatch the mutation a held item stands for: that call
 * happens outside this process, between reading `held` and releasing the
 * key. Two drivers reading the same snapshot could both dispatch, which for
 * a `finding` is a duplicate, permanent comment (`answer-summary-finding.ts`
 * posts a new one on every call). A claim is what lets only one of them.
 *
 * A claim is a row of the `claims` table: the clone, the PR, its kind
 * (`held` for a held item, keyed by the item's key; `ready` for the Ready
 * mark), a token and when it was taken or last renewed. Creating one is a
 * single insert that does nothing when the row exists, so of two claimants
 * exactly one wins, without the store's lock; only the rare recovery paths
 * (breaking a stale claim, giving one back) take that lock.
 *
 * A key can be claimed only while it is IN the held batch, checked AFTER the
 * claim is created: checking first and creating second is a check-then-act
 * with a gap in which the item can leave the batch. The other order's worst
 * case is a claim for a key that has just left, which the check right after
 * catches and gives back.
 *
 * A claim older than `DRIVE_PR_CLAIM_STALE_MIN` (10 minutes by default) is
 * abandoned and may be broken.
 */
import { randomBytes } from "node:crypto";
import { ExitError } from "../cli.ts";
import { driveDb } from "./db.ts";
import type { PathLock } from "./lock.ts";
import { currentIso, currentMs, parseMs } from "../../../../../shared/time.ts";

const CLAIM_STALE_MIN_DEFAULT = 10;

/**
 * `DRIVE_PR_CLAIM_STALE_MIN`, in minutes, clamped to [1, 1440]: lower and a
 * claim could be reclaimed before its owner finishes dispatching; higher and
 * an abandoned one could wedge recovery for longer than any dispatch runs.
 */
export function claimStaleMin(): number {
  const raw =
    process.env.DRIVE_PR_CLAIM_STALE_MIN ?? `${CLAIM_STALE_MIN_DEFAULT}`;
  if (!/^[0-9]+$/.test(raw)) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN='${raw}' is not a non-negative integer — using the default (${CLAIM_STALE_MIN_DEFAULT}m) instead of letting it silently make every claim un-reclaimable.`,
    );
    return CLAIM_STALE_MIN_DEFAULT;
  }
  if (raw.length > 12) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN='${raw}' has too many digits to compare safely — using the default (${CLAIM_STALE_MIN_DEFAULT}m) instead of letting an out-of-range value bypass the clamp.`,
    );
    return CLAIM_STALE_MIN_DEFAULT;
  }
  const v = Number.parseInt(raw, 10);
  if (v < 1) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN=${v} is below the safe minimum (1m) — clamping to 1m. Any lower and a claim could be reclaimed before its owner finishes dispatching.`,
    );
    return 1;
  }
  if (v > 1440) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN=${v} exceeds the safe maximum (1440m/24h) — clamping to 1440m. Any higher and an abandoned claim could wedge recovery for longer than any legitimate dispatch would ever run.`,
    );
    return 1440;
  }
  return v;
}

/** A claim's place: the clone's state directory, the PR, its kind and key. */
export interface ClaimRef {
  readonly stateDir: string;
  readonly pr: string;
  readonly kind: "held" | "ready";
  readonly key: string;
}

/** The claim over held item `key` of `pr`. */
export function claimRefFor(
  stateDir: string,
  pr: string,
  key: string,
): ClaimRef {
  return { stateDir, pr: canonical(pr), kind: "held", key };
}

/** The claim over `pr`'s draft→Ready transition. */
export function readyClaimRef(stateDir: string, pr: string): ClaimRef {
  return { stateDir, pr: canonical(pr), kind: "ready", key: "" };
}

/** A claim as a person reads it. */
export function claimLabel(ref: ClaimRef): string {
  return ref.kind === "ready"
    ? `PR #${ref.pr}'s Ready-mark claim`
    : `PR #${ref.pr}'s claim on held item ${ref.key}`;
}

function canonical(pr: string): string {
  return /^[0-9]+$/.test(pr) ? BigInt(pr).toString() : pr;
}

export function newClaimToken(): string {
  return `${process.pid}-${randomBytes(3).toString("hex")}`;
}

interface ClaimRow {
  token: string;
  at: string;
}

function row(ref: ClaimRef): ClaimRow | null {
  const drive = driveDb(ref.stateDir);
  return drive.db
    .query(
      "SELECT token, at FROM claims WHERE clone = ? AND pr = ? AND kind = ? AND key = ?",
    )
    .get(drive.clone, ref.pr, ref.kind, ref.key) as ClaimRow | null;
}

/** Create the claim with `token`; `true` when this call created it, `false` when one exists. */
export function claimCreate(ref: ClaimRef, token: string): boolean {
  const drive = driveDb(ref.stateDir);
  return (
    drive.db.run(
      `INSERT INTO claims (clone, pr, kind, key, token, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (clone, pr, kind, key) DO NOTHING`,
      [drive.clone, ref.pr, ref.kind, ref.key, token, currentIso()],
    ).changes === 1
  );
}

/** Whether the claim exists, live or not. */
export function claimExists(ref: ClaimRef): boolean {
  return row(ref) !== null;
}

/** Whether the claim exists and was taken or renewed within the staleness window. */
export function claimIsLive(ref: ClaimRef): boolean {
  const r = row(ref);
  if (r === null) return false;
  return currentMs() - parseMs(r.at) <= claimStaleMin() * 60_000;
}

/** Whether the claim exists under exactly `token`. */
export function claimTokenMatches(ref: ClaimRef, token: string): boolean {
  if (token === "") return false;
  return row(ref)?.token === token;
}

/** Renew the claim's clock, while it carries `token`; whether it did. */
export function claimTouch(ref: ClaimRef, token: string): boolean {
  const drive = driveDb(ref.stateDir);
  return (
    drive.db.run(
      "UPDATE claims SET at = ? WHERE clone = ? AND pr = ? AND kind = ? AND key = ? AND token = ?",
      [currentIso(), drive.clone, ref.pr, ref.kind, ref.key, token],
    ).changes === 1
  );
}

/** Remove the claim, whoever holds it. Callers check the token first, under the store's lock. */
export function removeClaim(ref: ClaimRef): void {
  const drive = driveDb(ref.stateDir);
  drive.db.run(
    "DELETE FROM claims WHERE clone = ? AND pr = ? AND kind = ? AND key = ?",
    [drive.clone, ref.pr, ref.kind, ref.key],
  );
}

/** With the store's lock held: remove the claim unless it is live; `true` when it is gone. */
export function breakStaleClaimLocked(ref: ClaimRef): boolean {
  if (claimIsLive(ref)) return false;
  removeClaim(ref);
  return true;
}

/**
 * Take the store's lock and break the claim when it is stale; `false` when
 * it is live or the lock could not be taken.
 */
export async function tryBreakStaleClaim(
  ref: ClaimRef,
  lock: PathLock,
): Promise<boolean> {
  try {
    await lock.acquire();
  } catch (e) {
    if (e instanceof ExitError) return false;
    throw e;
  }
  try {
    return breakStaleClaimLocked(ref);
  } finally {
    lock.release();
  }
}

/** Every held-item claim on `pr`. */
export function claimRefsFor(stateDir: string, pr: string): ClaimRef[] {
  const drive = driveDb(stateDir);
  return (
    drive.db
      .query(
        "SELECT key FROM claims WHERE clone = ? AND pr = ? AND kind = 'held' ORDER BY key",
      )
      .all(drive.clone, canonical(pr)) as { key: string }[]
  ).map((r) => claimRefFor(stateDir, pr, r.key));
}
