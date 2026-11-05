/** Acquire and release generation-addressed driver locks without removing a successor's. */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { isAliveSync, lockIdentity } from "../../../../../shared/liveness.ts";
import { fail } from "./../cli.ts";
import { type ClaimDiag, claimLive, parseDiagText } from "./../claim.ts";
import { formatAccountIdentity } from "./../identity.ts";
import { dbPathFor, driveDb } from "./../state/db.ts";
import {
  type LockRow,
  readLockRow,
  releaseLockRow,
  renewLockRow,
  takeLockRow,
} from "./../state/lock.ts";
import { clearDriverStopRequest } from "./../stop-request.ts";

// ── Single-instance locking ─────────────────────────────────────────────────

/**
 * ONE driver per shared resource, and a drive has TWO of them, so there are
 * two locks (each keying is correct against the other's hazard):
 *
 *   - the WORKTREE. Two drivers in one worktree edit, commit and push the
 *     same working tree, whether or not they target the same PR, so this
 *     lock is keyed by worktree and carries the PR only as diagnostics.
 *   - the PR. Two drivers in different worktrees never cross-ship edits, but
 *     they race pushes to one head branch and share the clone-wide durable
 *     state, so this lock is keyed by PR.
 *
 * Acquired in that fixed order, always, so two drivers contending for both
 * can never deadlock against each other.
 *
 * A lock is a row of the drive database's `locks` table (`state/lock.ts`):
 * the holder's process identity, the token of this acquisition, the
 * diagnostics (`ClaimDiag`) and the heartbeat. Staleness is keyed to the
 * holder's LIVENESS (`claim.ts`'s `claimLive`) rather than to a fixed age: a
 * lock whose holder is judged dead is stale however young, and a live pid is
 * honoured only while the holder keeps renewing its heartbeat, because a pid
 * alone cannot tell the driver from a stranger the OS handed its number to.
 * Every later write and removal addresses this acquisition's token, so a
 * driver whose lock was recovered by another can neither renew nor release
 * its successor's.
 */
export interface DriveLock {
  /** The clone's state directory, beside the database the lock lives in. */
  stateDir: string;
  /** The lock's name: `pr-drive-<PR>` or `pr-drive-worktree-<key>`. */
  name: string;
  /** What it protects, for the refusal message. */
  what: string;
  /**
   * Written into the lock's diagnostics at take time: what an exit-11
   * refusal and the `drives.ts` listing can show about THIS driver.
   * Advisory: nothing that decides liveness or recovery reads it.
   */
  diag?: ClaimDiag;
  /** This process's acquisition token, set when it is taken. */
  nonce?: string;
}

/** The name of a PR's driver lock. */
export function prLockName(pr: string): string {
  return `pr-drive-${pr}`;
}

/** A lock as a person reads it: its name and the database it is in. */
export function lockLabel(lock: { stateDir: string; name: string }): string {
  return `${lock.name} in ${dbPathFor(lock.stateDir)}`;
}

/** Who holds a driver lock, as one row says. */
export interface Claim {
  name: string;
  nonce: string;
  pid: number;
  host: string;
  hostId: string;
  bootId: string;
  start: string;
  platform: string;
  diag: ClaimDiag | null;
  /** When the holder last renewed its heartbeat. */
  renewedAt: string;
}

function claimOf(row: LockRow): Claim {
  return {
    name: row.name,
    nonce: row.token,
    pid: row.pid,
    host: row.host,
    hostId: row.host_id,
    bootId: row.boot_id,
    start: row.start,
    platform: row.platform,
    diag: row.detail === null ? null : parseDiagText(row.detail),
    renewedAt: row.renewed_at,
  };
}

/** The holder of driver lock `name`, or `null` when nobody holds it. */
export function inspectLock(stateDir: string, name: string): Claim | null {
  const row = readLockRow(driveDb(stateDir), name);
  return row === null ? null : claimOf(row);
}

/**
 * Is the holder alive? `claim.ts`'s rule, shared with the operator listing
 * so `drives.ts` can never call a lock live that recovery would take, or
 * the reverse: a holder judged dead by its recorded identity is gone; a
 * live pid counts only while its heartbeat is inside the window.
 */
export function claimAlive(claim: Claim): boolean {
  const verdict = isAliveSync({
    hostId: claim.hostId,
    host: claim.host,
    bootId: claim.bootId,
    pid: claim.pid,
    start: claim.start,
  });
  if (verdict.ok && verdict.value.state === "dead") return false;
  const age = Date.now() - Date.parse(claim.renewedAt);
  return claimLive({
    pid: claim.pid,
    host: claim.host,
    hostId: claim.hostId,
    platform: claim.platform,
    ageMs: Number.isFinite(age) ? age : null,
  });
}

/** The diagnostics of the live driver holding lock `name`, else `null`. */
export function liveHolder(
  stateDir: string,
  name: string,
): { diag: ClaimDiag | null } | null {
  const claim = inspectLock(stateDir, name);
  return claim !== null && claimAlive(claim) ? { diag: claim.diag } : null;
}

/** Take the lock over `seen` (or a free slot); whether this process now holds it. */
function takeLock(lock: DriveLock, seen: LockRow | null): boolean {
  const nonce = randomBytes(12).toString("hex");
  let taken: boolean;
  try {
    taken = takeLockRow(driveDb(lock.stateDir), lock.name, seen, {
      token: nonce,
      label: "drive.ts",
      holder: lockIdentity(),
      detail: lock.diag === undefined ? null : JSON.stringify(lock.diag),
    });
  } catch (error) {
    console.error(
      `drive.ts: could not publish lock ${lockLabel(lock)} (${error instanceof Error ? error.message : String(error)}).`,
    );
    return false;
  }
  if (taken) lock.nonce = nonce;
  return taken;
}

/**
 * Acquire, recovering a lock whose holder is gone by replacing the row that
 * was observed: of two contenders that observed the same stale holder, one
 * replaces it and the other's replace finds a token it did not see, and
 * refuses rather than drives.
 */
export function acquire(lock: DriveLock, pr: string): void {
  if (takeLock(lock, null)) return;
  const row = readLockRow(driveDb(lock.stateDir), lock.name);
  const held = row === null ? null : claimOf(row);
  if (held !== null && claimAlive(held)) {
    const about =
      held.diag === null
        ? []
        : [
            `That driver is working PR #${held.diag.pr} from ${held.diag.worktree}`,
            `(started ${held.diag.started}). Its log: ${held.diag.log}`,
            `Account: ${formatAccountIdentity(held.diag.account)}`,
          ];
    fail(
      11,
      `drive.ts: another driver already holds the ${lock.what} lock (pid ${held.pid} on ${held.host || "this host"}) — refusing to start a second loop.`,
      ...about,
      `Lock: ${lockLabel(lock)}. List live drives: drives.ts (same directory); stop one: drives.ts --stop <PR>.`,
      "If that loop is genuinely gone, run drives.ts --stop <PR> or wait for its heartbeat to age out.",
    );
  }
  if (held !== null) {
    console.error(
      `drive.ts: recovered a stale ${lock.what} lock (owner pid ${held.pid} is gone)`,
    );
  }
  if (!takeLock(lock, row)) {
    fail(
      11,
      `drive.ts: lost the ${lock.what} lock race for PR #${pr} — another driver recovered the same stale lock first.`,
    );
  }
}

/** Renew this acquisition's heartbeat; `false` when the lock is no longer this acquisition's. */
export function renewLock(lock: DriveLock, diag?: ClaimDiag): boolean {
  if (lock.nonce === undefined) return true;
  return renewLockRow(
    driveDb(lock.stateDir),
    lock.name,
    lock.nonce,
    diag === undefined ? undefined : JSON.stringify(diag),
  );
}

/** Where a driver keeps its process registry on Windows, while it holds `lock`. */
export function processRegistryDir(lock: DriveLock): string | null {
  return lock.nonce === undefined
    ? null
    : join(lock.stateDir, `${lock.name}.processes.${lock.nonce}`);
}

/**
 * Release ONLY the acquisition this process took, and leave the slot free:
 * the row goes only while it still carries this acquisition's token, so a
 * successor's lock is never removed. Its stop request and process registry
 * go with it; a stop's completion outlives it.
 */
export function release(lock: DriveLock): void {
  if (lock.nonce === undefined) return;
  const registry = processRegistryDir(lock);
  if (registry !== null) rmSync(registry, { recursive: true, force: true });
  clearDriverStopRequest(lock.stateDir, lock.name, lock.nonce);
  releaseLockRow(driveDb(lock.stateDir), lock.name, lock.nonce);
}
