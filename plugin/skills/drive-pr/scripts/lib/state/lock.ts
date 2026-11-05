/**
 * A named lock in the drive's database, around a read-modify-write that
 * spans more than one statement, or around an act that must not run twice at
 * once: the store's per-PR mutex (`store.ts`), the PR-wide remote-mutation
 * lock a push or a posted reply holds (`lease-model.ts`), the tree-lease
 * guard. Two drivers reading the same state, each adding a different parked
 * item, would otherwise both write, and the later one would silently drop the
 * earlier decision.
 *
 * A lock is a row of the `locks` table, keyed by the clone and the lock's
 * name: the holder's process identity (`shared/liveness.ts`), a token minted
 * for this acquisition, and its heartbeat. Taking it is one statement that
 * inserts the row when there is none, or replaces the row it saw when that
 * row's holder is gone; releasing it deletes the row only while it still
 * carries this acquisition's token, so a holder whose lock was broken and
 * taken by another cannot release its successor's. A release leaves nothing
 * behind.
 *
 * A lock is broken when its holder is judged dead on this host (the pid is
 * gone, or another process started under it, or the host restarted), or when
 * it has not been renewed within `DRIVE_PR_LOCK_STALE_MIN` (by default the
 * shared mutex expiry, `MUTEX_EXPIRY_MIN`): the work it guards takes seconds,
 * so a holder that late has hung. A holder on another host, or one whose
 * liveness cannot be read, keeps its lock until that window passes. A caller
 * that holds a lock across a long act, such as a `git push`, renews it with
 * `touch()` every `lockHeartbeatMs()`.
 */

import { randomBytes } from "node:crypto";
import { registerCleanup } from "../../../../../shared/cleanup.ts";
import {
  isAliveSync,
  lockIdentity,
  MUTEX_EXPIRY_MIN,
  type ProcessIdentity,
} from "../../../../../shared/liveness.ts";
import { poll, PollTimeoutError } from "../../../../../shared/retry.ts";
import { ExitError, sleep, testPacing } from "../cli.ts";
import { type DriveDb, driveDb } from "./db.ts";

/**
 * The hard ceiling on how long ONE `acquire()` may wait, whatever
 * `DRIVE_PR_LOCK_TIMEOUT` asks for. It is also the longest a command can sit
 * admitted but waiting between `claimLease` returning and its mutation
 * running, so the lease's staleness window is floored above it.
 */
export const LOCK_ACQUIRE_MAX_SEC = 300;

/**
 * `acquire` gave up waiting: the lock is held by someone else. Every other
 * failure (the database cannot be written) is what the platform threw, so a
 * caller can tell contention from a broken store.
 */
export class LockAcquireTimeoutError extends ExitError {
  constructor() {
    super(1);
  }
}

function signedEnv(name: string, def: number): number {
  const raw = process.env[name] ?? "";
  return /^-?[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : def;
}

/** `DRIVE_PR_LOCK_STALE_MIN` (default `MUTEX_EXPIRY_MIN`); a negative value makes every lock stale, for tests. */
export function lockStaleMinutes(): number {
  return signedEnv("DRIVE_PR_LOCK_STALE_MIN", MUTEX_EXPIRY_MIN);
}

/** How long one acquire waits: `DRIVE_PR_LOCK_TIMEOUT` seconds (default 30), never above `LOCK_ACQUIRE_MAX_SEC` or `maxWaitSec`. */
export function lockWaitSec(maxWaitSec?: number): number {
  return Math.min(
    LOCK_ACQUIRE_MAX_SEC,
    Math.max(0, signedEnv("DRIVE_PR_LOCK_TIMEOUT", 30)),
    ...(maxWaitSec === undefined ? [] : [Math.max(0, maxWaitSec)]),
  );
}

/**
 * Run `attempt` every `everyMs` until it takes the lock or `limitSec` passes.
 * Out of time, it prints `refusal` to stderr and throws
 * `LockAcquireTimeoutError`; whatever `attempt` throws is thrown.
 */
export async function pollForLock(
  attempt: () => boolean,
  everyMs: number,
  limitSec: number,
  refusal: readonly string[],
): Promise<void> {
  try {
    await poll(async () => attempt(), {
      everyMs,
      until: (held) => held,
      deadlineMs: performance.now() + limitSec * 1000,
      immediate: true,
      clock: {
        now: () => performance.now(),
        sleep: (ms) => sleep(ms / 1000),
      },
    });
  } catch (error) {
    if (!(error instanceof PollTimeoutError)) throw error;
    for (const line of refusal) console.error(line);
    throw new LockAcquireTimeoutError();
  }
}

/** Never heartbeat slower than this, however large the staleness window is. */
const LOCK_HEARTBEAT_MAX_MS = 120_000;

/**
 * How often a caller holding a lock across a long act must `touch()` it so
 * it never reads as stale: a quarter of the staleness window, capped at two
 * minutes and floored at one second.
 */
export function lockHeartbeatMs(): number {
  const derived = Math.max(
    1_000,
    Math.min(
      LOCK_HEARTBEAT_MAX_MS,
      Math.floor((lockStaleMinutes() * 60_000) / 4),
    ),
  );
  return testPacing("DRIVE_PR_LOCK_HEARTBEAT_MS", derived, 100);
}

export interface PathLock extends Disposable {
  /**
   * @param maxWaitSec optional cap on THIS call's wait, applied on top of the
   * configured timeout (never above it), for a caller waiting through many
   * locks under one deadline.
   */
  acquire(maxWaitSec?: number): Promise<void>;
  /** Release this acquisition, if this process still holds it. Idempotent. */
  release(): void;
  /** Release, and remove the process-exit cleanup registration. Idempotent. */
  dispose(): void;
  /** Renew the heartbeat of a lock this process holds; a no-op otherwise. */
  touch(): void;
}

/** A lock row as the table holds it. */
export interface LockRow {
  name: string;
  token: string;
  label: string;
  pid: number;
  host_id: string;
  host: string;
  boot_id: string;
  start: string;
  platform: string;
  detail: string | null;
  acquired_at: string;
  renewed_at: string;
}

/** The holder of a lock row. */
export function lockHolder(row: LockRow): ProcessIdentity {
  return {
    hostId: row.host_id,
    host: row.host,
    bootId: row.boot_id,
    pid: row.pid,
    start: row.start,
  };
}

/** The row of lock `name` in this clone, or `null` when nobody holds it. */
export function readLockRow(drive: DriveDb, name: string): LockRow | null {
  return drive.db
    .query("SELECT * FROM locks WHERE clone = ? AND name = ?")
    .get(drive.clone, name) as LockRow | null;
}

/** Every lock row of this clone. */
export function lockRows(drive: DriveDb): LockRow[] {
  return drive.db
    .query("SELECT * FROM locks WHERE clone = ? ORDER BY name")
    .all(drive.clone) as LockRow[];
}

/**
 * Take lock `name` for `holder` when it is free or `seen` is the row to
 * replace: one statement, so of two contenders that saw the same row only one
 * replaces it. `true` when this call now holds it.
 */
export function takeLockRow(
  drive: DriveDb,
  name: string,
  seen: LockRow | null,
  row: {
    token: string;
    label: string;
    holder: ProcessIdentity;
    detail: string | null;
  },
): boolean {
  const now = new Date().toISOString();
  const values = [
    row.token,
    row.label,
    row.holder.pid,
    row.holder.hostId,
    row.holder.host,
    row.holder.bootId,
    row.holder.start,
    process.platform,
    row.detail,
    now,
    now,
  ];
  if (seen === null)
    return (
      drive.db.run(
        `INSERT INTO locks (clone, name, token, label, pid, host_id, host, boot_id, start, platform, detail, acquired_at, renewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (clone, name) DO NOTHING`,
        [drive.clone, name, ...values],
      ).changes === 1
    );
  return (
    drive.db.run(
      `UPDATE locks SET token = ?, label = ?, pid = ?, host_id = ?, host = ?, boot_id = ?, start = ?, platform = ?, detail = ?, acquired_at = ?, renewed_at = ?
       WHERE clone = ? AND name = ? AND token = ?`,
      [...values, drive.clone, name, seen.token],
    ).changes === 1
  );
}

/** Delete lock `name` while it still carries `token`; `true` when it did. */
export function releaseLockRow(
  drive: DriveDb,
  name: string,
  token: string,
): boolean {
  return (
    drive.db.run(
      "DELETE FROM locks WHERE clone = ? AND name = ? AND token = ?",
      [drive.clone, name, token],
    ).changes === 1
  );
}

/** Renew lock `name`'s heartbeat while it still carries `token`; `true` when it did. */
export function renewLockRow(
  drive: DriveDb,
  name: string,
  token: string,
  detail?: string,
): boolean {
  const now = new Date().toISOString();
  return (
    (detail === undefined
      ? drive.db.run(
          "UPDATE locks SET renewed_at = ? WHERE clone = ? AND name = ? AND token = ?",
          [now, drive.clone, name, token],
        )
      : drive.db.run(
          "UPDATE locks SET renewed_at = ?, detail = ? WHERE clone = ? AND name = ? AND token = ?",
          [now, detail, drive.clone, name, token],
        )
    ).changes === 1
  );
}

/** Why a mutex row may be broken, or `null` while its holder keeps it. */
function staleReason(row: LockRow, staleMs: number): string | null {
  const verdict = isAliveSync(lockHolder(row));
  if (verdict.ok && verdict.value.state === "dead") return verdict.value.reason;
  const age = Date.now() - Date.parse(row.renewed_at);
  if (!Number.isFinite(age) || age > staleMs)
    return `not renewed for more than ${Math.max(0, Math.round(staleMs / 60_000))}m`;
  return null;
}

/**
 * The lock `name` of the clone whose state directory is `stateDir`. `label`
 * names the owning script in its diagnostics; `prLabel` names the PR in the
 * timeout message. Released on process exit and on a signal, and then only
 * the acquisition this process took.
 */
export function createLock(
  stateDir: string,
  name: string,
  label: string,
  prLabel: string,
): PathLock {
  let token: string | null = null;

  function release(): void {
    if (token === null) return;
    const mine = token;
    token = null;
    try {
      releaseLockRow(driveDb(stateDir), name, mine);
    } catch (error) {
      console.error(
        `${label}: could not release ${name} (${error instanceof Error ? error.message : String(error)}); it is broken once its holder is seen gone.`,
      );
    }
  }
  const cleanup = registerCleanup(release);
  function dispose(): void {
    release();
    cleanup[Symbol.dispose]();
  }

  function touch(): void {
    if (token === null) return;
    try {
      renewLockRow(driveDb(stateDir), name, token);
    } catch {
      // The next heartbeat tries again; a lock that is really gone is what
      // this process's own release finds out.
    }
  }

  function attempt(staleMinutes: number): boolean {
    const drive = driveDb(stateDir);
    const seen = readLockRow(drive, name);
    let replace: LockRow | null = null;
    if (seen !== null) {
      const why = staleReason(seen, staleMinutes * 60_000);
      if (why === null) return false;
      replace = seen;
      console.error(`${label}: broke a stale lock ${name} (${why})`);
    }
    const mine = randomBytes(12).toString("hex");
    if (
      !takeLockRow(drive, name, replace, {
        token: mine,
        label,
        holder: lockIdentity(),
        detail: null,
      })
    )
      return false;
    token = mine;
    return true;
  }

  async function acquire(maxWaitSec?: number): Promise<void> {
    if (token !== null) return;
    const limit = lockWaitSec(maxWaitSec);
    const retryMs = Math.min(
      1_000,
      Math.max(10, signedEnv("DRIVE_PR_LOCK_RETRY_MS", 50)),
    );
    const staleMinutes = lockStaleMinutes();
    await pollForLock(() => attempt(staleMinutes), retryMs, limit, [
      `${label}: could not acquire ${name} within ${limit}s.`,
      `Another driver is updating PR #${prLabel}'s state, or the lock is wedged.`,
    ]);
  }

  return { acquire, release, dispose, touch, [Symbol.dispose]: dispose };
}
