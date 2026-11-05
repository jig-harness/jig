/**
 * Fixtures over the drive's database (`scripts/lib/state/db.ts`): seed,
 * read and edit the rows a probe arranges, through the same modules the
 * scripts use, so a fixture cannot drift from the schema it stands in for.
 * Every helper takes a clone's state directory (`scopedStateDir`), whose
 * database sits beside it.
 */
import { hostname } from "node:os";
import { thisHost } from "../../../shared/liveness.ts";
import { driveDb, nextCount } from "../scripts/lib/state/db.ts";
import type {
  Lease,
  LeaseRef,
  TreeLease,
  TreeLeaseRef,
} from "../scripts/lib/state/lease.ts";
import {
  readLease,
  readTreeLease,
  removeLease,
  removeTreeLease,
  writeLease,
  writeTreeLease,
} from "../scripts/lib/state/lease.ts";
import { type LockRow, readLockRow } from "../scripts/lib/state/lock.ts";
import { readStateRow, writeStateRow } from "../scripts/lib/state/store.ts";

/** Write a PR's state: an object as the store writes it, a string as it is. */
export function writeState(stateDir: string, pr: string, state: unknown): void {
  writeStateRow(
    stateDir,
    pr,
    typeof state === "string" ? state : `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** A PR's stored state text, or `null` when it has none. */
export function stateText(stateDir: string, pr: string): string | null {
  return readStateRow(stateDir, pr)?.text ?? null;
}

/** A PR's stored state, parsed; `null` when it has none. */
export function readState(
  stateDir: string,
  pr: string,
): Record<string, unknown> | null {
  const text = stateText(stateDir, pr);
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

/** Whether a PR has stored state. */
export function hasState(stateDir: string, pr: string): boolean {
  return readStateRow(stateDir, pr) !== null;
}

/** Rewrite a PR's stored state through `edit`. */
export function editState(
  stateDir: string,
  pr: string,
  edit: (s: Record<string, unknown>) => Record<string, unknown>,
): void {
  const state = readState(stateDir, pr);
  if (state === null) throw new Error(`PR #${pr} has no state to edit`);
  writeState(stateDir, pr, edit(state));
}

/** A lease with every field set: a live session of this process, unless `over` says otherwise. */
function leaseFixture(over: Partial<Lease> = {}): Lease {
  const now = new Date().toISOString();
  const host = thisHost();
  // A lease named on another host carries no host id of this one, so it is
  // judged by name, as a lease from that host would be.
  const here = over.host === undefined || over.host === hostname();
  return {
    holder: "session",
    pid: process.pid,
    host: hostname(),
    hostId: here ? host.hostId : "",
    bootId: here ? host.bootId : "",
    start: "",
    platform: process.platform,
    actor: "wt-0000000000000000",
    worktree: "",
    startedAt: now,
    lastSeen: now,
    expiresAt: new Date(Date.now() + 360 * 60_000).toISOString(),
    command: "fixture",
    generation: 1,
    sessionStarted: "",
    ...over,
  };
}

/** A tree lease with every field set; see `leaseFixture`. */
function treeLeaseFixture(over: Partial<TreeLease> = {}): TreeLease {
  return {
    ...leaseFixture(over),
    pr: "999",
    revision: "fixture-revision",
    ...over,
  };
}

/**
 * A generation the clone's counter hands out, as an admission draws one: a
 * planted lease never shares its generation with a later takeover's.
 */
function drawnGeneration(stateDir: string): number {
  return nextCount(driveDb(stateDir), "lease-generation");
}

/** Write the per-PR lease at `ref`, its actor the ref's, its generation drawn from the counter unless `over` names one. */
export function putLease(ref: LeaseRef, over: Partial<Lease> = {}): Lease {
  const lease = leaseFixture({
    actor: ref.actor,
    generation: over.generation ?? drawnGeneration(ref.stateDir),
    ...over,
  });
  writeLease(ref, lease);
  return lease;
}

/** Write the tree lease at `ref`, its actor the ref's; its generation as `putLease`'s. */
export function putTreeLease(
  ref: TreeLeaseRef,
  over: Partial<TreeLease> = {},
): TreeLease {
  const lease = treeLeaseFixture({
    actor: ref.actor,
    generation: over.generation ?? drawnGeneration(ref.stateDir),
    ...over,
  });
  writeTreeLease(ref, lease);
  return lease;
}

/** Rewrite the per-PR lease at `ref` through `edit`. */
export function editLease(ref: LeaseRef, edit: (l: Lease) => Lease): void {
  const lease = readLease(ref);
  if (lease === null) throw new Error("no lease to edit");
  writeLease(ref, edit(lease));
}

/** Rewrite the tree lease at `ref` through `edit`. */
export function editTreeLease(
  ref: TreeLeaseRef,
  edit: (l: TreeLease) => TreeLease,
): void {
  const lease = readTreeLease(ref);
  if (lease === null) throw new Error("no tree lease to edit");
  writeTreeLease(ref, edit(lease));
}

export { readLease, readTreeLease, removeLease, removeTreeLease, writeLease };

/** A lock row's holder and heartbeat, for a fixture. */
export interface LockFixture {
  token?: string;
  label?: string;
  pid?: number;
  host?: string;
  hostId?: string;
  bootId?: string;
  start?: string;
  platform?: string;
  /** A driver lock's diagnostics. */
  diag?: unknown;
  acquiredAt?: string;
  renewedAt?: string;
}

/** Write lock `name` of the clone as `f` says, replacing any holder. */
export function putLock(
  stateDir: string,
  name: string,
  f: LockFixture = {},
): void {
  const drive = driveDb(stateDir);
  const now = new Date().toISOString();
  const host = thisHost();
  // A lock named on another host carries no host id of this one.
  const here = f.host === undefined || f.host === hostname();
  drive.db.run(
    `INSERT OR REPLACE INTO locks (clone, name, token, label, pid, host_id, host, boot_id, start, platform, detail, acquired_at, renewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      drive.clone,
      name,
      f.token ?? "aaaaaaaaaaaaaaaaaaaaaaaa",
      f.label ?? "fixture",
      f.pid ?? process.pid,
      f.hostId ?? (here ? host.hostId : ""),
      f.host ?? hostname(),
      f.bootId ?? (here ? host.bootId : ""),
      f.start ?? "",
      f.platform ?? process.platform,
      f.diag === undefined ? null : JSON.stringify(f.diag),
      f.acquiredAt ?? now,
      f.renewedAt ?? now,
    ],
  );
}

/** Lock `name`'s row, or `null` when nobody holds it. */
export function lockRow(stateDir: string, name: string): LockRow | null {
  return readLockRow(driveDb(stateDir), name);
}

/** Remove lock `name`, whoever holds it. */
export function removeLock(stateDir: string, name: string): void {
  const drive = driveDb(stateDir);
  drive.db.run("DELETE FROM locks WHERE clone = ? AND name = ?", [
    drive.clone,
    name,
  ]);
}

/** The names of every lock held in the clone. */
export function lockNames(stateDir: string): string[] {
  const drive = driveDb(stateDir);
  return (
    drive.db
      .query("SELECT name FROM locks WHERE clone = ? ORDER BY name")
      .all(drive.clone) as { name: string }[]
  ).map((r) => r.name);
}

/** Write a claim row: a held item's (`key` its key) or the Ready mark's (`key` empty). */
export function putClaim(
  stateDir: string,
  pr: string,
  kind: "held" | "ready",
  key: string,
  token: string,
  at = new Date().toISOString(),
): void {
  const drive = driveDb(stateDir);
  drive.db.run(
    "INSERT OR REPLACE INTO claims (clone, pr, kind, key, token, at) VALUES (?, ?, ?, ?, ?, ?)",
    [drive.clone, pr, kind, key, token, at],
  );
}

/** A claim row's token and time, or `null`. */
export function claimRow(
  stateDir: string,
  pr: string,
  kind: "held" | "ready",
  key = "",
): { token: string; at: string } | null {
  const drive = driveDb(stateDir);
  return drive.db
    .query(
      "SELECT token, at FROM claims WHERE clone = ? AND pr = ? AND kind = ? AND key = ?",
    )
    .get(drive.clone, pr, kind, key) as { token: string; at: string } | null;
}

/** Every held-item claim row on `pr`. */
export function heldClaims(
  stateDir: string,
  pr: string,
): { key: string; token: string; at: string }[] {
  const drive = driveDb(stateDir);
  return drive.db
    .query(
      "SELECT key, token, at FROM claims WHERE clone = ? AND pr = ? AND kind = 'held' ORDER BY key",
    )
    .all(drive.clone, pr) as { key: string; token: string; at: string }[];
}

/** The driver record of `pr`, or `null`. */
export function driverRecordRow(
  stateDir: string,
  pr: string,
): Record<string, unknown> | null {
  const drive = driveDb(stateDir);
  return drive.db
    .query("SELECT * FROM driver_records WHERE clone = ? AND pr = ?")
    .get(drive.clone, pr) as Record<string, unknown> | null;
}

/** Every stop row of the clone. */
export function stopRows(stateDir: string): Record<string, unknown>[] {
  const drive = driveDb(stateDir);
  return drive.db
    .query("SELECT * FROM stops WHERE clone = ? ORDER BY lock, nonce")
    .all(drive.clone) as Record<string, unknown>[];
}
