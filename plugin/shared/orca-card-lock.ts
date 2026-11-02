/**
 * The lock over one Orca workspace card's comment.
 *
 * A card holds one comment, and Orca's comment write replaces all of it, so a
 * writer that must not replace a comment a person has not read reads the
 * card first and writes after. Two writers doing that at once (a drive's
 * stop and the dispatcher's notification, say) would each read the old
 * comment and the second write would drop the first one's text. Every comment
 * writer (`orca-board.ts` and the dispatcher's notify) therefore holds this
 * lock across its read and its write.
 *
 * The lock is a file under the user's state directory (not the temporary directory, which a launcher can change per process), named after
 * the workspace's path and created exclusively, holding its owner's pid and a
 * token. Release removes it only while it still holds that token. A lock
 * whose owner is no longer running is reclaimed by one reclaimer at a time.
 * The lock is published whole (linked into place from a private file), so
 * an interrupted acquisition leaves no empty lock. A writer that cannot take the lock within its
 * deadline gets `null` and skips its write: the board is a convenience.
 *
 * The lock is local to the machine: writers on different hosts of paired
 * Orca servers do not exclude each other, and a card they both write can
 * lose the earlier unread addition.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { swallow } from "./errors.ts";

/** Milliseconds a writer waits for the lock before it skips. */
const CARD_LOCK_WAIT_MS = 5000;

const POLL_MS = 50;

export interface CardLockOptions {
  /** The directory the locks live in; the user's state directory by default. */
  root?: string;
  waitMs?: number;
}

/** Runs `body` holding the card's lock; `null` when the lock was not taken in time. */
export type CardLock = <T>(
  workspace: string,
  body: () => Promise<T>,
  options?: CardLockOptions,
) => Promise<{ value: T } | null>;

/** The lock file for the workspace at `path`. */
export function cardLockPath(path: string, root = defaultRoot()): string {
  const key = createHash("sha256")
    .update(resolve(path))
    .digest("hex")
    .slice(0, 32);
  return join(root, `orca-card.${key}.lock`);
}

function defaultRoot(): string {
  return join(homedir(), ".local", "state", "jig", "orca-card-locks");
}

/** The pid a lock file records; `null` when it cannot be read. */
function ownerOf(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").split("\n")[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    swallow(error, "an unreadable lock file names no owner");
    return null;
  }
}

/** Only a recorded owner the process table no longer has makes a lock stale. */
function ownerGone(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Remove a stale lock. Reclaimers take turns through a mutex file, so only
 * one at a time judges and removes a lock: a lock whose recorded owner is
 * gone cannot be replaced by anyone else (a new holder needs the path free,
 * and only a reclaimer frees it), so the file removed is the one judged. A
 * mutex whose holder is gone is broken; one that names no owner, after
 * `MUTEX_STALE_MS`.
 */
function reclaim(lock: string): void {
  if (!ownerGone(ownerOf(lock))) return;
  const mutex = `${lock}.reclaim`;
  if (!publish(mutex, `${process.pid}\n`)) {
    breakStaleMutex(mutex);
    return;
  }
  try {
    if (ownerGone(ownerOf(lock))) rmSync(lock, { force: true });
  } finally {
    rmSync(mutex, { force: true });
  }
}

/** Milliseconds after which a reclaim mutex that names no owner is taken to be left by a dead reclaimer. */
const MUTEX_STALE_MS = 10_000;

function breakStaleMutex(mutex: string): void {
  try {
    // A reclaimer still running may only be slow: its mutex is broken once
    // its process is gone, and by age only when it names no owner.
    const owner = ownerOf(mutex);
    const stale =
      owner === null
        ? Date.now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS
        : ownerGone(owner);
    if (stale) rmSync(mutex, { force: true });
  } catch (error) {
    swallow(error, "the mutex was released meanwhile");
  }
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

/** Take the lock of the workspace at `workspace`, run `body`, release. */
export async function withCardLock<T>(
  workspace: string,
  body: () => Promise<T>,
  options: CardLockOptions = {},
): Promise<{ value: T } | null> {
  const root = options.root ?? defaultRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = cardLockPath(workspace, root);
  const token = randomUUID();
  const content = `${process.pid}\n${token}\n`;
  const deadline = performance.now() + (options.waitMs ?? CARD_LOCK_WAIT_MS);
  while (!tryTake(lock, content)) {
    reclaim(lock);
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
