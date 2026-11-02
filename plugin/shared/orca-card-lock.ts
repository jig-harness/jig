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
 * under a mutex file beside it; a mutex whose owner is gone is superseded by
 * a next-generation mutex, never moved or removed by another process.
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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/** The content of a lock file; `null` when it cannot be read. */
function readLock(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    swallow(error, "an unreadable lock file names no owner");
    return null;
  }
}

/** The pid a lock file's content records; `null` when it names none. */
function pidOf(content: string): number | null {
  const pid = Number(content.split("\n")[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
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
 * content of this lock, not only the one judged: the completed mutexes of
 * content that no longer stands, and the staging files of publishers that are
 * gone. A live publisher's staging file and the standing content's mutexes are
 * never touched. Walking the generations and the sweep both stop at
 * `deadline`, so neither a chain of abandoned mutexes nor a large set of
 * leftover files can hold the caller past its wait; what the sweep leaves, any
 * later reclaim of this lock finds and removes.
 */
function reclaim(lock: string, deadline: number): void {
  const judged = readLock(lock);
  if (judged === null || !ownerGone(pidOf(judged))) return;
  const id = createHash("sha256").update(judged).digest("hex").slice(0, 16);
  const prefix = `${basename(lock)}.reclaim-${id}-`;
  const content = `${process.pid}\n${randomUUID()}\n`;
  let mutex: string;
  for (let generation = 1; ; generation++) {
    if (performance.now() >= deadline) return;
    mutex = join(dirname(lock), `${prefix}${generation}`);
    if (publish(mutex, content)) break;
    const held = readLock(mutex);
    if (held === null || !ownerGone(pidOf(held))) return;
  }
  try {
    if (readLock(lock) === judged) rmSync(lock, { force: true });
  } finally {
    rmSync(mutex, { force: true });
    sweep(lock, deadline);
  }
}

/** Remove the completed mutexes and dead publishers' staging files of every content of `lock`. */
function sweep(lock: string, deadline: number): void {
  const family = `${basename(lock)}.reclaim-`;
  const standing = readLock(lock);
  const standingId =
    standing === null
      ? null
      : createHash("sha256").update(standing).digest("hex").slice(0, 16);
  for (const name of readdirSync(dirname(lock))) {
    if (performance.now() >= deadline) break;
    const [, id, rest] = name.startsWith(family)
      ? (/^([0-9a-f]{16})-(.*)$/.exec(name.slice(family.length)) ?? [])
      : [];
    if (id !== undefined && id !== standingId && sweepable(rest ?? ""))
      rmSync(join(dirname(lock), name), { force: true });
  }
}

/**
 * Whether the rest of a mutex file's name, after the prefix, names a completed
 * mutex (a generation number) or a staging file whose publisher is gone.
 */
function sweepable(rest: string): boolean {
  if (/^\d+$/.test(rest)) return true;
  const staged = /^\d+\.init-(\d+)-/.exec(rest);
  return staged !== null && ownerGone(Number(staged[1]));
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
