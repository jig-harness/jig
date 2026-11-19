/**
 * The tick's repository locks: the wait for one another tick holds, and the
 * keys the forge repository's locks are kept under in the tick's lock map.
 */
import { currentMs } from "../../shared/time.ts";
import type { Lock } from "../receipts.ts";
import { type TickContext, tickBound } from "./tick-context.ts";

/** The key a repository's lock is kept under in the tick's lock map, beside the checkouts' paths. */
export const REPOSITORY_LOCK_PREFIX = "repository:";

/** How often a lock wait looks at the lock again. */
const LOCK_POLL_MS = 250;

/**
 * A repository lock (`take` tries once), waited for until `deadline` and the
 * tick's own deadline, so a repository another tick holds only briefly is
 * read in this tick; who holds it when the wait ran out. Both lock scopes, the
 * checkout's and the forge repository's, wait alike, sharing one `deadline`.
 * `null` when `owned` turns true meanwhile: another checkout of this tick took
 * the lock, which is not reentrant, so waiting on it would only time out.
 */
export async function waitForLock(
  take: () => Lock,
  context: TickContext,
  deadline: number,
  owned?: () => boolean,
  waiting?: () => void,
): Promise<Lock | null> {
  for (;;) {
    if (owned?.() === true) return null;
    const lock = take();
    if (
      !("heldBy" in lock) ||
      currentMs() >= deadline ||
      tickBound(context)?.signal.aborted === true
    )
      return lock;
    waiting?.();
    await Bun.sleep(LOCK_POLL_MS);
  }
}

/** Gives up the repository locks the checkouts shared: the settle phase takes them again. */
export function releaseRepositoryLocks(
  locks: Map<string, { release(): void }>,
): void {
  for (const [key, lock] of locks) {
    if (!key.startsWith(REPOSITORY_LOCK_PREFIX)) continue;
    lock.release();
    locks.delete(key);
  }
}
