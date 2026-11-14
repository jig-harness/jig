/**
 * The session lease's rows: reading and writing them, whether a holder is
 * still driving, and whether a lease is the caller's own.
 *
 * Every function here is one statement, or is called inside a caller's
 * transaction (`db.ts`'s `inTransaction`), so a read and the write it decides
 * see one state of the table. A row always has every field: each column is
 * `NOT NULL`, and `holder` is `session` or `worktree`.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { hostname } from "node:os";
import { swallow } from "../../../../../shared/errors.ts";
import {
  fence,
  isAliveSync,
  lockIdentity,
  isStale,
  type Lease as HeldLease,
  type ProcessIdentity,
  thisHost,
} from "../../../../../shared/liveness.ts";
import { pidCheckCommand } from "../proc.ts";
import { dbPathFor, driveDb, nextCount, peekImport } from "./db.ts";
import {
  type Lease,
  type LeaseRef,
  leaseRef,
  leaseStaleMin,
  leaseStaleMs,
  type Session,
  type TreeLease,
  type TreeLeaseRef,
  treeLeaseRef,
} from "./lease-model.ts";
import { currentMs, isoFromMs, parseMs } from "../../../../../shared/time.ts";

/** A `leases` or `tree_leases` row. */
interface LeaseRow {
  pr: string;
  actor: string;
  holder: "session" | "worktree";
  pid: number;
  host_id: string;
  host: string;
  boot_id: string;
  start: string;
  platform: string;
  worktree: string;
  command: string;
  session_started: string;
  generation: number;
  started_at: string;
  renewed_at: string;
  expires_at: string;
  revision?: string;
}

function fromRow(row: LeaseRow): Lease {
  return {
    holder: row.holder,
    pid: row.pid,
    host: row.host,
    hostId: row.host_id,
    bootId: row.boot_id,
    start: row.start,
    platform: row.platform,
    actor: row.actor,
    worktree: row.worktree,
    startedAt: row.started_at,
    lastSeen: row.renewed_at,
    expiresAt: row.expires_at,
    command: row.command,
    generation: row.generation,
    sessionStarted: row.session_started,
  };
}

function columns(l: Lease): (string | number)[] {
  return [
    l.holder,
    l.pid,
    l.hostId,
    l.host,
    l.bootId,
    l.start,
    l.platform,
    l.worktree,
    l.command,
    l.sessionStarted,
    l.generation,
    l.startedAt,
    l.lastSeen,
    l.expiresAt,
  ];
}

const LEASE_COLUMNS =
  "holder, pid, host_id, host, boot_id, start, platform, worktree, command, session_started, generation, started_at, renewed_at, expires_at";

/** The per-PR lease at `ref`, or `null` when there is none. */
export function readLease(ref: LeaseRef): Lease | null {
  const drive = driveDb(ref.stateDir);
  const row = drive.db
    .query("SELECT * FROM leases WHERE clone = ? AND pr = ? AND actor = ?")
    .get(drive.clone, ref.pr, ref.actor) as LeaseRow | null;
  return row === null ? null : fromRow(row);
}

/** The tree lease at `ref`, or `null` when there is none. */
export function readTreeLease(ref: TreeLeaseRef): TreeLease | null {
  const drive = driveDb(ref.stateDir);
  const row = drive.db
    .query("SELECT * FROM tree_leases WHERE clone = ? AND actor = ?")
    .get(drive.clone, ref.actor) as LeaseRow | null;
  return row === null
    ? null
    : { ...fromRow(row), pr: row.pr, revision: row.revision ?? "" };
}

/** Write the per-PR lease at `ref`, replacing whatever was there. */
export function writeLease(ref: LeaseRef, lease: Lease): void {
  const drive = driveDb(ref.stateDir);
  drive.db.run(
    `INSERT OR REPLACE INTO leases (clone, pr, actor, ${LEASE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [drive.clone, ref.pr, ref.actor, ...columns(lease)],
  );
}

/** Write the tree lease at `ref`, replacing whatever was there. */
export function writeTreeLease(ref: TreeLeaseRef, lease: TreeLease): void {
  const drive = driveDb(ref.stateDir);
  drive.db.run(
    `INSERT OR REPLACE INTO tree_leases (clone, actor, pr, revision, ${LEASE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [drive.clone, ref.actor, lease.pr, lease.revision, ...columns(lease)],
  );
}

/** Remove the per-PR lease at `ref`; whether one was there. */
export function removeLease(ref: LeaseRef): boolean {
  const drive = driveDb(ref.stateDir);
  return (
    drive.db.run(
      "DELETE FROM leases WHERE clone = ? AND pr = ? AND actor = ?",
      [drive.clone, ref.pr, ref.actor],
    ).changes === 1
  );
}

/** Remove the tree lease at `ref`; whether one was there. */
export function removeTreeLease(ref: TreeLeaseRef): boolean {
  const drive = driveDb(ref.stateDir);
  return (
    drive.db.run("DELETE FROM tree_leases WHERE clone = ? AND actor = ?", [
      drive.clone,
      ref.actor,
    ]).changes === 1
  );
}

/** Every per-PR lease on `pr`, whichever tree holds it. */
export function leaseRefsFor(stateDir: string, pr: string): LeaseRef[] {
  const drive = driveDb(stateDir);
  const canonical = leaseRef(stateDir, pr, "").pr;
  return (
    drive.db
      .query(
        "SELECT actor FROM leases WHERE clone = ? AND pr = ? ORDER BY actor",
      )
      .all(drive.clone, canonical) as { actor: string }[]
  ).map((r) => leaseRef(stateDir, canonical, r.actor));
}

/**
 * Every per-PR lease THIS working tree holds, whichever PR each is for: the
 * external-mutation fence reaches here from a caller that does not know its
 * PR and must not spend a network round-trip to learn it.
 */
export function leaseRefsForActor(stateDir: string, actor: string): LeaseRef[] {
  const drive = driveDb(stateDir);
  return (
    drive.db
      .query(
        "SELECT pr FROM leases WHERE clone = ? AND actor = ? ORDER BY CAST(pr AS INTEGER)",
      )
      .all(drive.clone, actor) as { pr: string }[]
  ).map((r) => leaseRef(stateDir, r.pr, actor));
}

/** A lease's holder, as the shared liveness module records one. */
export function leaseIdentity(l: Lease): ProcessIdentity {
  return {
    hostId: l.hostId,
    host: l.host,
    bootId: l.bootId,
    pid: l.pid,
    start: l.start,
  };
}

/** A lease as the shared module's `Lease`, its expiry by this reader's window. */
function asHeldLease(l: Lease): HeldLease {
  const renewed = parseMs(l.lastSeen);
  return {
    holder: leaseIdentity(l),
    generation: l.generation,
    startedAt: l.startedAt,
    renewedAt: l.lastSeen,
    expiresAt: Number.isFinite(renewed)
      ? isoFromMs(renewed + leaseStaleMs())
      : l.lastSeen,
  };
}

/**
 * Is the lease's holder still driving? Both halves must hold: the holder is
 * not judged dead (its pid is gone, another process now has it, or its host
 * restarted; a holder on another host, or one whose liveness cannot be read,
 * is not judged dead), AND it renewed within this reader's window. Either
 * alone is the recycled-pid hazard, from opposite sides. A `worktree` holder
 * has no process, so freshness alone decides.
 */
export function leaseAlive(l: Lease): boolean {
  const held = asHeldLease(l);
  const verdict = l.holder === "session" ? isAliveSync(held.holder) : undefined;
  if (!Number.isFinite(parseMs(l.lastSeen))) return false;
  return !isStale(held, Temporal.Now.instant(), verdict);
}

/** Every LIVE lease on `pr`, from every working tree. */
export function liveLeasesFor(stateDir: string, pr: string): Lease[] {
  return leaseRefsFor(stateDir, pr).flatMap((ref) => {
    const l = readLease(ref);
    return l !== null && leaseAlive(l) ? [l] : [];
  });
}

/**
 * Every LIVE lease on `pr`, read without creating, migrating or importing
 * anything: `null` when that cannot be known without writing (no database,
 * the clone never imported, or the database cannot be read). For a dry run,
 * which must leave the disk as it is.
 */
export function peekLiveLeasesFor(
  stateDir: string,
  pr: string,
): Lease[] | null {
  if (!existsSync(dbPathFor(stateDir)) || peekImport(stateDir) === null)
    return null;
  let db: Database;
  try {
    db = new Database(dbPathFor(stateDir), { readonly: true });
  } catch (err) {
    swallow(err, "the drive's database could not be opened read-only");
    return null;
  }
  try {
    const canonical = leaseRef(stateDir, pr, "").pr;
    const rows = db
      .query("SELECT * FROM leases WHERE clone = ? AND pr = ?")
      .all(basename(stateDir), canonical) as LeaseRow[];
    return rows.map(fromRow).filter(leaseAlive);
  } catch (err) {
    swallow(err, "the drive's leases could not be read");
    return null;
  } finally {
    db.close();
  }
}

/**
 * The live per-PR and tree leases the tree `actor` names holds, read through
 * `db`, a connection the caller opened (read-only, for a caller that must
 * leave the disk as it is) on the database of clone `clone`.
 */
export function liveLeasesOfTree(
  db: Database,
  clone: string,
  actor: string,
): Lease[] {
  const rows = [
    ...(db
      .query("SELECT * FROM leases WHERE clone = ? AND actor = ?")
      .all(clone, actor) as LeaseRow[]),
    ...(db
      .query("SELECT * FROM tree_leases WHERE clone = ? AND actor = ?")
      .all(clone, actor) as LeaseRow[]),
  ];
  return rows.map(fromRow).filter(leaseAlive);
}

/** Whether a live session is still behind this tree's lease. */
export function liveTreeLeaseFor(stateDir: string, actor: string): boolean {
  const l = readTreeLease(treeLeaseRef(stateDir, actor));
  return l !== null && leaseAlive(l);
}

/**
 * How fresh THIS tree's lease must be for a claim to skip the PR-wide check
 * and the store's lock: half the window. A foreign tree is admitted only
 * after reading our lease as not alive, which it cannot while our renewal is
 * inside this margin, by hours rather than by a boundary two processes could
 * straddle.
 */
export function leaseFreshMarginMs(): number {
  return Math.floor(leaseStaleMs() / 2);
}

/** The "is that session still alive?" line every lease refusal ends with. */
export function leaseLivenessHint(l: Lease): string {
  if (l.holder === "worktree") {
    return `That record names no session — it was written by a runtime that identified none (ladder tier 3), so there is no process to check. It clears on its own once ${leaseStaleMin()}m pass without a mutating command from ${l.worktree || l.actor}.`;
  }
  const cmd = pidCheckCommand(l.pid, l.host, l.platform);
  const remote = l.host !== "" && l.host !== hostname();
  if (cmd === null) {
    return `Check whether that session is still alive — pid ${l.pid} ON ${l.host}, whose platform this lease does not record, so run that host's own process check.`;
  }
  return remote
    ? `Check whether that session is still alive — ON ${l.host}, where its pid lives:  ${cmd}`
    : `Check whether that session is still alive:  ${cmd}`;
}

/**
 * How a refusal NAMES a lease's holder: never a pid a `worktree` holder does
 * not have (pid 0 addresses the caller's own process group on POSIX).
 */
export function leaseHolderLabel(l: Lease): string {
  return l.holder === "worktree"
    ? "a sessionless resolver (ladder tier 3 — no session identity to name)"
    : `session pid ${l.pid} on ${l.host || "this host"}`;
}

export function ageLabel(iso: string): string {
  const ms = currentMs() - parseMs(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

/**
 * Is `l` the lease session `s` itself holds? A `worktree` holder is owned by
 * its tree, so `actor` decides. A session's lease is its own on (pid, host)
 * and, once the session carries an acquisition token, the SAME token: a pid
 * is recyclable, so a token mismatch proves another process. A tokenless
 * session owns only a tokenless lease (an interactive `$CLAUDE_PID` session
 * never carries one); two tokenless sessions sharing a recycled pid are
 * indistinguishable from a renewal, which the window bounds.
 *
 * Not `actor`-qualified for a session: one session legitimately drives from
 * two trees, and its second tree's lease must not read as foreign to it.
 */
export function isMine(l: Lease, s: Session, actor: string): boolean {
  if (l.holder === "worktree") return l.actor === actor;
  if (l.pid !== s.pid || l.host !== s.host) return false;
  if (s.sessionStarted !== "") return l.sessionStarted === s.sessionStarted;
  return l.sessionStarted === "";
}

/**
 * Is `l` PROVABLY a dead predecessor's lease whose pid the OS has since
 * handed to `s`? `leaseAlive`'s pid half answers about `s` itself once the
 * pids match, so this strips that tautology before a claim decides renewal
 * against takeover. The proof is temporal, so it needs both claims
 * timestamped: both tokens non-empty, both strict ISO instants that
 * round-trip, `l`'s strictly earlier. Then `l`'s writer cannot be alive
 * holding the pid: a pid passes on only after its holder ends, so the
 * session that minted `s`'s token started after `l`'s writer was gone.
 * Every other shape returns `false`, which only means the ordinary staleness
 * wait applies: a false refusal recoverable in one command, never a false
 * takeover.
 */
export function isRecycledPid(l: Lease, s: Session, actor: string): boolean {
  if (l.pid !== s.pid || l.host !== s.host || isMine(l, s, actor)) {
    return false;
  }
  if (l.sessionStarted === "" || s.sessionStarted === "") return false;
  const lMs = parseStrictIsoInstantMs(l.sessionStarted);
  const sMs = parseStrictIsoInstantMs(s.sessionStarted);
  if (lMs === null || sMs === null) return false;
  return lMs < sMs;
}

/** `s` as an ISO instant, only when it round-trips through `isoFromMs`. */
function parseStrictIsoInstantMs(s: string): number | null {
  const ms = parseMs(s);
  if (Number.isNaN(ms)) return null;
  return isoFromMs(ms) === s ? ms : null;
}

/** The identity a lease written now records for `session`'s holder. */
function holderIdentity(
  holder: Lease["holder"],
  session: Session,
): ProcessIdentity {
  if (holder === "worktree" || session.pid === 0)
    return { ...thisHost(), host: hostname(), pid: 0, start: "" };
  return { ...lockIdentity(session.pid), host: session.host };
}

/**
 * The lease a claim writes: renewed in place (its generation and start
 * kept) when `preserveGeneration`, or new, under the next generation.
 */
export function leaseForClaim(
  holder: Lease["holder"],
  session: Session,
  actor: string,
  worktree: string,
  command: string,
  held: Lease | null,
  preserveGeneration: boolean,
  stateDir: string,
): Lease {
  const now = currentMs();
  const keep = preserveGeneration && held !== null;
  const id =
    keep && held.pid === session.pid
      ? leaseIdentity(held)
      : holderIdentity(holder, session);
  return {
    holder,
    pid: holder === "worktree" ? 0 : session.pid,
    host: session.host,
    hostId: id.hostId,
    bootId: id.bootId,
    start: holder === "worktree" ? "" : id.start,
    platform: process.platform,
    actor,
    worktree,
    startedAt: keep ? held.startedAt : isoFromMs(now),
    lastSeen: isoFromMs(now),
    expiresAt: isoFromMs(now + leaseStaleMs()),
    command,
    generation: keep
      ? held.generation
      : nextCount(driveDb(stateDir), "lease-generation"),
    sessionStarted: session.sessionStarted,
  };
}

/** A fresh tree-lease revision token. */
export function newRevision(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Whether `held` is still the lease a command was admitted on: the same
 * holder at a generation `liveness.ts`'s `fence` accepts. A later generation
 * means a takeover or a re-admission happened since; none, that it was swept.
 */
export function sameAdmission(held: Lease | null, admitted: Lease): boolean {
  return (
    held !== null &&
    held.pid === admitted.pid &&
    held.host === admitted.host &&
    fence(admitted.generation, held.generation).ok
  );
}
