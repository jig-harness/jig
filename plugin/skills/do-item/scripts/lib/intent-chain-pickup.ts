/** Immutable pickup sources for late PR capture.
 * Identifier aliases and session copies describe the latest pickup; this
 * content-addressed envelope preserves the exact bytes and ownership of an
 * earlier one. Tokens are explicit handles, never inferred from file age.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const PICKUP_MAX_BYTES = 64 * 1024;
export const PICKUP_TOKEN_RE = /^[a-f0-9]{64}$/;
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ARM_LINE_RE = /^<!-- refocus-arm: (on|off) -->$/;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** An active publication holds its temporary file for milliseconds; anything
 * this old was abandoned by a terminated writer. */
const TEMPORARY_ABANDONED_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_RE = /^\.tmp-\d+-[0-9a-f-]{36}$/;
/** A lock is held for a few syscalls; one this old was left by a killed holder. */
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 2000;
/** `LOCK_WAIT_MS`, which a test pacing seam (not configuration) can only
 * lower, so a probe that waits out a held lock need not sleep through it. */
function lockWaitMs(): number {
  const raw = process.env.DO_ITEM_LOCK_WAIT_MS ?? "";
  return /^[0-9]+$/.test(raw)
    ? Math.min(LOCK_WAIT_MS, Math.max(10, Number(raw)))
    : LOCK_WAIT_MS;
}
const LOCK_FILE = ".lock";
const PUBLISH_RETRIES = 3;

export interface PickupSnapshot {
  identifiers: string[];
  text: string;
}

/** The one mutual-exclusion primitive for the intent-chain stores: an exclusive
 * lock file, awaited briefly and reclaimed when a killed holder left it behind.
 * Every operation that can displace or delete an existing file (renewal vs
 * expiry deletion, pin refresh vs pin repair) must run under the same lock;
 * creators that publish with `link` need none, since `link` fails while the
 * target exists.
 *
 * Ownership is explicit: the lock holds its owner's token, release unlinks only
 * a lock still carrying it, and a stale lock is reclaimed by renaming it aside
 * and judging the inode that was actually moved. A bare stat-then-unlink would
 * let a contender delete a lock a rival had just re-created. One residual
 * remains: a contender that moved aside a lock which turned out to be live
 * restores it with `link`, and a third contender acquiring inside that gap
 * defeats the restore. It needs a killed holder plus three contenders inside a
 * few syscalls, and the loser then fails the restore rather than proceeding
 * silently.
 *
 * That residual is the bound of the class, not a gap to patch: time-based
 * reclaim over rename/link/unlink admits displaced-holder windows whenever a
 * holder is dead or stalls past LOCK_STALE_MS mid-callback and contenders
 * arrive within a few syscalls. Only an OS lock (a native dependency) or an
 * atomic no-replace rename would remove it. The cost is one regenerable scratch
 * artifact, which the next round reports with its re-capture command. */
export function withFileLock<T>(
  lock: string,
  fn: () => T,
  waitMs = lockWaitMs(),
): T {
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  for (;;) {
    try {
      writeFileSync(lock, token, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (reclaimStaleLock(lock)) continue;
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for lock ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
    } catch {
      // Already reclaimed as stale; nothing left to release.
    }
  }
}

/** True when the lock slot is free to retry (reclaimed, or already gone). */
function reclaimStaleLock(lock: string): boolean {
  try {
    if (Date.now() - lstatSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const aside = `${lock}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  // The inode moved is the one judged, not the one stat'd above: a rival may
  // have reclaimed and re-created the lock in between.
  if (Date.now() - lstatSync(aside).mtimeMs > LOCK_STALE_MS) {
    unlinkSync(aside);
    return true;
  }
  try {
    linkSync(aside, lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    unlinkSync(aside);
    throw new Error(`lost a live lock to a rival while reclaiming ${lock}`);
  }
  unlinkSync(aside);
  return false;
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validated(input: unknown): PickupSnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("pickup must be an ownership and text envelope");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Array.isArray(record.identifiers) ||
    record.identifiers.length === 0 ||
    !record.identifiers.every(
      (id: unknown): id is string =>
        typeof id === "string" && IDENTIFIER_RE.test(id),
    ) ||
    new Set(record.identifiers).size !== record.identifiers.length ||
    typeof record.text !== "string"
  )
    throw new Error("pickup has invalid ownership identifiers or text");
  if (!ARM_LINE_RE.test(record.text.split("\n", 1)[0] ?? ""))
    throw new Error("pickup text does not start with the writer's arm line");
  return { identifiers: [...record.identifiers], text: record.text };
}

export interface ReadPickupOptions {
  /** Read a source past its retention window. Only an identical rewrite sets
   * this: it is a live pickup that restarts the window. */
  allowExpired?: boolean;
  now?: number;
}

/** Throws on missing, expired, unsafe, oversized, corrupt, or malformed
 * sources. Expiry is enforced here and not only by the writer's prune, which
 * runs on default-path writes alone and so cannot be relied on to have removed
 * a source older than the retention window.
 * All checks and bytes use one descriptor so atomic replacement cannot swap
 * an unchecked inode between validation and reading.
 */
export function readPickup(
  chainDir: string,
  token: string,
  { allowExpired = false, now = Date.now() }: ReadPickupOptions = {},
): PickupSnapshot {
  if (!PICKUP_TOKEN_RE.test(token)) throw new Error("invalid pickup token");
  const file = join(chainDir, "pickups", `${token}.json`);
  // Nonblocking open lets fstat refuse a FIFO even when no writer is attached.
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("pickup is not a regular file");
    if (!allowExpired && now - stat.mtimeMs > RETENTION_MS)
      throw new Error("pickup has expired");
    if (stat.size > PICKUP_MAX_BYTES)
      throw new Error(`pickup exceeds the ${PICKUP_MAX_BYTES}-byte bound`);
    // Read one byte beyond the bound as well: a file growing after fstat must
    // fail rather than letting a bounded prefix masquerade as the whole file.
    const bytes = Buffer.alloc(PICKUP_MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, count);
      if (n === 0) break;
      count += n;
    }
    if (count > PICKUP_MAX_BYTES)
      throw new Error(`pickup exceeds the ${PICKUP_MAX_BYTES}-byte bound`);
    const body = bytes.subarray(0, count);
    if (digest(body) !== token) throw new Error("pickup content hash mismatch");
    return validated(JSON.parse(body.toString("utf8")) as unknown);
  } finally {
    closeSync(fd);
  }
}

/** Atomically publishes a complete owner-only source, exclusively. Repeating
 * an identical write keeps the original inode; a corrupt existing source is
 * an error, never silently overwritten under its supposedly immutable token.
 */
export function writePickup(
  chainDir: string,
  identifiers: string[],
  text: string,
): string {
  const snapshot = validated({
    identifiers: [...new Set(identifiers)].sort(),
    text,
  });
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body) > PICKUP_MAX_BYTES)
    throw new Error(`pickup exceeds the ${PICKUP_MAX_BYTES}-byte bound`);
  const token = digest(body);
  const dir = join(chainDir, "pickups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${token}.json`);
  const temporary = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  let failure: { error: unknown } | undefined;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    // Reusing identical scope is a live pickup, so the retention window
    // restarts without changing its content or inode. Validation and renewal
    // share one lock hold, so expiry deletion cannot interleave; a deletion
    // that wins before that hold leaves the slot empty, so publish again.
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(temporary, file);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        renewPickup(chainDir, token, { verify: true });
        break;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          attempt >= PUBLISH_RETRIES
        )
          throw error;
      }
    }
  } catch (error) {
    failure = { error };
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const prior = failure
        ? `; publication failed: ${String(failure.error)}`
        : "";
      throw new Error(
        `cannot remove pickup temporary file: ${String(error)}${prior}`,
      );
    }
  }
  if (failure) throw failure.error;
  return token;
}

/** Restarts a source's retention window; capture calls it after a verified
 * read, so a source in use is not pruned by an unrelated pickup. Runs under
 * the directory lock that expiry deletion also takes, so a renewal that
 * returns cannot be followed by a deletion decided on the pre-renewal mtime.
 * `verify` re-reads the source (expired allowed) inside that same hold.
 */
export function renewPickup(
  chainDir: string,
  token: string,
  { verify = false }: { verify?: boolean } = {},
): void {
  const dir = join(chainDir, "pickups");
  withFileLock(join(dir, LOCK_FILE), () => {
    if (verify) readPickup(chainDir, token, { allowExpired: true });
    const now = new Date();
    utimesSync(join(dir, `${token}.json`), now, now);
  });
}

/** Best effort, like the writer's other retention paths. Prunes only regular
 * token-named envelopes and abandoned publication temporaries; links,
 * unrelated files and recent files survive.
 */
export function prunePickups(chainDir: string, now = Date.now()): void {
  const dir = join(chainDir, "pickups");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  // One lock hold for the whole pass, taken once: a lock that cannot be had
  // ends this best-effort pass rather than costing a wait per archive.
  try {
    withFileLock(join(dir, LOCK_FILE), () => {
      for (const name of names) {
        const maxAge = /^[a-f0-9]{64}\.json$/.test(name)
          ? RETENTION_MS
          : TEMPORARY_RE.test(name)
            ? TEMPORARY_ABANDONED_MS
            : null;
        if (maxAge === null) continue;
        try {
          // Stat inside the hold renewal also takes, so the expiry decision
          // cannot be stale by the time of the unlink.
          const path = join(dir, name);
          const stat = lstatSync(path);
          if (stat.isFile() && now - stat.mtimeMs > maxAge) unlinkSync(path);
        } catch {
          // A vanished file or a permissions failure must not block a pickup.
        }
      }
    });
  } catch {
    // Lock unavailable or lost: skip pruning; the next pickup retries.
  }
}
