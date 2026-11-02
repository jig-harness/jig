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
 * The lock is a file under the user's state directory (not the temporary
 * directory, which a launcher can change per process), named after the
 * workspace's path and created exclusively, holding its owner's pid and a
 * token. Release removes it only while it still holds that token. A lock
 * whose owner is no longer running is removed by one reclaimer at a time,
 * under a short mutex file beside it.
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

/** Milliseconds after which a reclaim mutex is taken to be abandoned. */
const RECLAIM_ABANDONED_MS = 10_000;

/**
 * Remove a stale lock while holding the reclaim mutex, so one reclaimer at a
 * time judges and removes it. While the stale file stands at the lock path no
 * writer can publish there, and only a reclaimer ever removes a lock it did not
 * take, so the file judged under the mutex is the file removed: a live
 * holder's lock is never in the way. The mutex is held for two file reads and
 * one removal, with no waiting; a mutex older than `RECLAIM_ABANDONED_MS`
 * belongs to a reclaimer that died inside that stretch and is removed.
 */
function reclaim(lock: string, abandonedMs = RECLAIM_ABANDONED_MS): void {
  if (!ownerGone(ownerOf(lock))) return;
  const mutex = `${lock}.reclaim`;
  const content = `${process.pid}\n${randomUUID()}\n`;
  if (!publish(mutex, content)) {
    try {
      if (Date.now() - statSync(mutex).mtimeMs > abandonedMs) {
        rmSync(mutex, { force: true });
      }
    } catch (error) {
      swallow(error, "the reclaimer holding the mutex finished first");
    }
    return;
  }
  try {
    if (ownerGone(ownerOf(lock))) rmSync(lock, { force: true });
  } finally {
    try {
      if (readFileSync(mutex, "utf8") === content) rmSync(mutex);
    } catch (error) {
      swallow(error, "the mutex was already removed as abandoned");
    }
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
