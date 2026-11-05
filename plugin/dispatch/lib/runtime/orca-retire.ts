/**
 * `retire` on Orca: the notices workspace removed with `orca worktree rm
 * --delete-branch`, which stops its terminals, drops its card and deletes
 * its branch when Orca can prove the branch merged. Before it, under the
 * card's comment lock (the one `notify` and every comment writer take), the
 * card is read again (`orca worktree show`): a comment or an unread mark
 * other than the one the tick decided on means a message arrived or was
 * read meanwhile, and nothing is removed. One deadline covers the lock's
 * wait and every call.
 */
import { isRecord } from "../../../shared/guards.ts";
import { type CardLock, withCardLock } from "../../../shared/orca-card-lock.ts";
import { call } from "./orca-comment.ts";
import type { RuntimeReceipt } from "./port.ts";

export async function orcaRetire(
  target: { id: string; path: string },
  expected: { comment: string; unread: boolean },
  timeoutMs: number,
  lock: CardLock = withCardLock,
): Promise<RuntimeReceipt> {
  const start = performance.now();
  const remaining = (): number => timeoutMs - (performance.now() - start);
  let locked: { value: RuntimeReceipt } | null;
  try {
    locked = await lock(
      target.path,
      () => retireUnlocked(target, expected, remaining),
      { waitMs: Math.max(0, Math.min(timeoutMs, 5000)) },
    );
  } catch (error) {
    return {
      ok: false,
      detail: `${target.path}: the card's comment lock could not be taken: ${error instanceof Error ? error.message : String(error)}; nothing removed`,
    };
  }
  return (
    locked?.value ?? {
      ok: false,
      detail: `${target.path}: another writer held the card's comment past the lock's deadline; nothing removed`,
    }
  );
}

async function retireUnlocked(
  target: { id: string; path: string },
  expected: { comment: string; unread: boolean },
  remaining: () => number,
): Promise<RuntimeReceipt> {
  const selector = `path:${target.path}`;
  if (remaining() <= 0)
    return {
      ok: false,
      detail: `${target.path}: the runtime's deadline passed before the card was read; nothing removed`,
    };
  const shown = await call(
    ["worktree", "show", "--worktree", selector],
    remaining(),
  );
  if (!shown.ok) return { ok: false, detail: `${shown.why}; nothing removed` };
  const worktree = isRecord(shown.result) ? shown.result.worktree : undefined;
  const comment =
    isRecord(worktree) && typeof worktree.comment === "string"
      ? worktree.comment
      : "";
  const unread = isRecord(worktree) && worktree.isUnread === true;
  if (comment !== expected.comment || unread !== expected.unread)
    return {
      ok: false,
      detail: `${target.path}: its comment or unread mark changed since the tick read it; nothing removed`,
    };
  if (remaining() <= 0)
    return {
      ok: false,
      detail: `${target.path}: the runtime's deadline passed before the removal; nothing removed`,
    };
  const removed = await call(
    ["worktree", "rm", "--worktree", selector, "--delete-branch"],
    remaining(),
  );
  if (!removed.ok)
    return { ok: false, lost: removed.lost, detail: removed.why };
  return { ok: true, detail: `${target.path} removed with its branch` };
}
