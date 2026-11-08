/**
 * An exclusive lock on one key, held across a short read and write, for a
 * writer that must not interleave with another.
 *
 * The lock is a file under the caller's directory, named after the caller
 * and a digest of the key and created exclusively, holding its owner's pid,
 * a token and its owner's process identity (`liveness.ts`), one per line; a
 * lock in its earlier two-line form is judged by its pid alone. Release
 * removes it only while it still holds that token. A lock whose owner is no
 * longer running (its pid gone, or now held by a process that started at
 * another time) is removed by one reclaimer at a time, under a mutex file
 * beside it, and the reclaimer reports whose it was and why it counts as
 * gone; a mutex whose owner is gone is superseded by a next-generation mutex,
 * never moved or removed by another process. The lock is published whole
 * (linked into place from a private file), so an interrupted acquisition
 * leaves no empty lock. A caller that cannot take the lock within its wait
 * gets `null`.
 *
 * The lock is local to the machine. The Orca card lock (`orca-card-lock.ts`)
 * and the scheduled upgrade's claim (`runtime/scheduled-upgrade.ts`) take it.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { swallow } from "./errors.ts";
import {
  decodeIdentity,
  describeIdentity,
  encodeIdentity,
  isAliveSync,
  legacyIdentity,
  ownIdentity,
  type ProcessIdentity,
} from "./liveness.ts";
import { log } from "./log.ts";

/** Milliseconds a caller waits for the lock before it skips, unless it names its own wait. */
const LOCK_WAIT_MS = 5000;

const POLL_MS = 50;

export interface FileLockOptions {
  /** The directory the locks live in. */
  root: string;
  /** What the lock file is named after: `<name>.<digest of the key>.lock`. */
  name: string;
  waitMs?: number;
}

/** The lock file for `key` under `root`, named after `name`. */
export function fileLockPath(key: string, root: string, name: string): string {
  const digest = createHash("sha256")
    .update(resolve(key))
    .digest("hex")
    .slice(0, 32);
  return join(root, `${name}.${digest}.lock`);
}

/** The content of a lock file; `null` when it cannot be read. */
function readLock(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    swallow(error, "an unreadable lock file names no owner");
    return null;
  }
}

/**
 * The owner a lock or mutex file's content records: its identity when the
 * third line holds one for the first line's pid, else that pid alone;
 * `null` when it names none.
 */
function ownerOf(content: string): ProcessIdentity | null {
  const [first, , third] = content.split("\n");
  const pid = Number(first);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const recorded = third ? decodeIdentity(third) : null;
  return recorded?.pid === pid ? recorded : legacyIdentity(pid);
}

/**
 * Why a recorded owner counts as gone, or `null` while it may still run:
 * only an owner judged dead makes a lock stale, never one that cannot be read
 * or judged.
 */
function ownerGone(
  owner: ProcessIdentity | null,
  deadline: number,
): string | null {
  if (owner === null) return null;
  const verdict = isAliveSync(owner, undefined, deadline);
  return verdict.ok && verdict.value.state === "dead"
    ? `${describeIdentity(owner)}: ${verdict.value.reason}`
    : null;
}

/** Why the owner a file's content records counts as gone; `null` while it may run, or when nothing was read. */
function staleOwner(content: string | null, deadline: number): string | null {
  return content === null ? null : ownerGone(ownerOf(content), deadline);
}

/** A lock or mutex file's content for this process: pid, a fresh token, identity. */
function ownContent(): string {
  return `${process.pid}\n${randomUUID()}\n${encodeIdentity(ownIdentity())}\n`;
}

/**
 * Remove a stale lock while holding a reclaim mutex, so one live reclaimer at
 * a time judges and removes it. The mutex is named after the content judged
 * and a generation number, and is never moved or removed by anyone but its
 * owner: a reclaimer that finds the current generation's owner gone takes the
 * next generation instead of taking the file over, so no path ever points at
 * a file a live process owns when it is touched. While the stale file stands
 * at the lock path no writer can publish there, and only a reclaimer removes a
 * lock it did not take, so the file judged under the mutex is the file removed.
 * Once content is no longer what stands at the lock path no reclaimer can act
 * on it again (a lock's token is never reused), so the sweep covers every
 * content of this lock, not only the one judged, but removes only what its
 * owner has left behind: a mutex or staging file a live process owns, and the
 * standing content's mutexes, are never touched. Walking the generations and the sweep both stop at
 * `deadline`, so neither a chain of abandoned mutexes nor a large set of
 * leftover files can hold the caller past its wait; what the sweep leaves, a
 * later reclaim of this lock finds and removes, which happens when a later
 * holder of the lock dies.
 */
function reclaim(lock: string, deadline: number): void {
  const judged = readLock(lock);
  if (judged === null) return;
  const gone = ownerGone(ownerOf(judged), deadline);
  if (gone === null) return;
  const id = createHash("sha256").update(judged).digest("hex").slice(0, 16);
  const prefix = `${basename(lock)}.reclaim-${id}-`;
  const content = ownContent();
  let mutex: string;
  for (let generation = 1; ; generation++) {
    if (performance.now() >= deadline) return;
    mutex = join(dirname(lock), `${prefix}${generation}`);
    if (publish(mutex, content)) break;
    if (staleOwner(readLock(mutex), deadline) === null) return;
  }
  try {
    if (readLock(lock) === judged) {
      rmSync(lock, { force: true });
      log.warn(`took over the lock ${lock} from ${gone}`);
    }
  } finally {
    rmSync(mutex, { force: true });
    sweep(lock, deadline);
  }
}

/**
 * Remove the leftovers of every content of `lock` whose owner is gone: a
 * mutex whose recorded owner is no longer running, and a staging file whose
 * publisher is no longer running. What a live process owns is never touched,
 * whatever generation or content it belongs to, and the standing content is
 * read afresh before each removal, so a snapshot that went stale while the
 * sweep ran cannot reach a mutex of the content that stands now.
 */
function sweep(lock: string, deadline: number): void {
  const dir = dirname(lock);
  const family = `${basename(lock)}.reclaim-`;
  for (const name of readdirSync(dir)) {
    if (performance.now() >= deadline) break;
    const [, id, rest] = name.startsWith(family)
      ? (/^([0-9a-f]{16})-(.*)$/.exec(name.slice(family.length)) ?? [])
      : [];
    if (id === undefined || id === standingId(lock)) continue;
    const file = join(dir, name);
    if (leftover(file, rest ?? "", deadline)) rmSync(file, { force: true });
  }
}

/** The id the mutex names of the content standing at `lock` carry; `null` when none stands. */
function standingId(lock: string): string | null {
  const standing = readLock(lock);
  return standing === null
    ? null
    : createHash("sha256").update(standing).digest("hex").slice(0, 16);
}

/**
 * Whether `file`, named `rest` after the prefix, is a mutex whose owner is gone
 * or a staging file whose publisher is gone.
 */
function leftover(file: string, rest: string, deadline: number): boolean {
  if (/^\d+$/.test(rest)) {
    return staleOwner(readLock(file), deadline) !== null;
  }
  const staged = /^\d+\.init-(\d+)-/.exec(rest);
  return (
    staged !== null &&
    ownerGone(legacyIdentity(Number(staged[1])), deadline) !== null
  );
}

/**
 * Create `file` holding `content` exclusively and whole: the content is
 * written to a private file first and linked into place, so no reader sees
 * the file empty and a failed write leaves nothing at `file`. False when
 * `file` exists.
 */
function publish(file: string, content: string): boolean {
  const staged = `${file}.init-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(staged, content, { flag: "wx", mode: 0o600 });
    linkSync(staged, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(staged, { force: true });
  }
}

function tryTake(lock: string, content: string): boolean {
  return publish(lock, content);
}

/** Takes the lock for `key`, runs `body` and releases it; `null` when the lock was not taken in time. */
export async function withFileLock<T>(
  key: string,
  body: () => Promise<T>,
  options: FileLockOptions,
): Promise<{ value: T } | null> {
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const lock = fileLockPath(key, options.root, options.name);
  const content = ownContent();
  const deadline = performance.now() + (options.waitMs ?? LOCK_WAIT_MS);
  while (!tryTake(lock, content)) {
    reclaim(lock, deadline);
    if (performance.now() >= deadline) return null;
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  try {
    return { value: await body() };
  } finally {
    try {
      if (readFileSync(lock, "utf8") === content) rmSync(lock);
    } catch (error) {
      swallow(error, "reclaimed as stale already; nothing left to release");
    }
  }
}
