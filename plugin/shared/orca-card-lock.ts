/**
 * The lock over one Orca workspace card's comment.
 *
 * A card holds one comment, and Orca's comment write replaces all of it, so a
 * writer that must not replace a comment a person has not read reads the
 * card first and writes after. Two writers doing that at once (a drive's
 * stop and the dispatcher's notification, say) would each read the old
 * comment and the second write would drop the first one's text. Every comment
 * writer (`orca-board.ts`, the dispatcher's notify and its launch mark) therefore holds this
 * lock across its read and its write.
 *
 * The lock is a file lock (`file-lock.ts`) under the user's state directory
 * (not the temporary directory, which a launcher can change per process),
 * named after the workspace's path: created exclusively, published whole,
 * released only by its owner, and reclaimed from an owner that is no longer
 * running. A writer that cannot take the lock within its
 * deadline gets `null` and skips its write: the board is a convenience.
 *
 * The lock is local to the machine: writers on different hosts of paired
 * Orca servers do not exclude each other, and a card they both write can
 * lose the earlier unread addition.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileLockPath, withFileLock } from "./file-lock.ts";

/** Milliseconds a writer waits for the lock before it skips. */
const CARD_LOCK_WAIT_MS = 5000;

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

const NAME = "orca-card";

function defaultRoot(): string {
  return join(homedir(), ".local", "state", "jig", "orca-card-locks");
}

/** The lock file for the workspace at `path`. */
export function cardLockPath(path: string, root = defaultRoot()): string {
  return fileLockPath(path, root, NAME);
}

/** Take the lock of the workspace at `workspace`, run `body`, release. */
export function withCardLock<T>(
  workspace: string,
  body: () => Promise<T>,
  options: CardLockOptions = {},
): Promise<{ value: T } | null> {
  return withFileLock(workspace, body, {
    root: options.root ?? defaultRoot(),
    name: NAME,
    waitMs: options.waitMs ?? CARD_LOCK_WAIT_MS,
  });
}
