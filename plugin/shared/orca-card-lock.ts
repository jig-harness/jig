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
 * The lock is a file under the machine's temporary directory, named after
 * the workspace's path and created exclusively, holding its owner's pid and a
 * token. Release removes it only while it still holds that token. A lock
 * whose owner is no longer running is reclaimed: it is renamed aside, and
 * the file actually moved is judged, so a rival's fresh lock is never
 * removed in its place. A writer that cannot take the lock within its
 * deadline gets `null` and skips its write: the board is a convenience.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { swallow } from "./errors.ts";

/** Milliseconds a writer waits for the lock before it skips. */
const CARD_LOCK_WAIT_MS = 5000;

const POLL_MS = 50;

export interface CardLockOptions {
  /** The directory the locks live in; the machine's temporary directory by default. */
  root?: string;
  waitMs?: number;
}

/** Runs `body` holding the card's lock; `null` when the lock was not taken in time. */
export type CardLock = <T>(
  workspace: string,
  body: () => Promise<T>,
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
  return join(tmpdir(), "jig-orca-card-locks");
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

/** Move a stale lock aside and remove it; a live one moved by a race goes back. */
function reclaim(lock: string): void {
  if (!ownerGone(ownerOf(lock))) return;
  const aside = `${lock}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    swallow(error, "another writer moved or released the lock first");
    return;
  }
  if (!ownerGone(ownerOf(aside))) {
    try {
      linkSync(aside, lock);
    } catch (error) {
      swallow(error, "a new holder took the slot meanwhile; its lock stands");
    }
  }
  rmSync(aside, { force: true });
}

function tryTake(lock: string, content: string): boolean {
  try {
    writeFileSync(lock, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
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
