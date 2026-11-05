/**
 * `retire` on Orca: the notices workspace removed with `orca worktree rm
 * --delete-branch`, which stops its terminals, drops its card and deletes
 * its branch when Orca can prove the branch merged. Before it, under the
 * card's comment lock (the one `notify` and every comment writer take), the
 * card is read again (`orca worktree show`): a comment or an unread mark
 * other than the one the tick decided on means a message arrived or was
 * read meanwhile, and nothing is removed. One deadline covers the lock's
 * wait and every call. Orca has no conditional removal command; the final
 * listing comparison narrows but cannot eliminate a concurrent external edit.
 */
import { gitIdentityEnv, run } from "../../../shared/proc.ts";
import { isRecord } from "../../../shared/guards.ts";
import { type CardLock, withCardLock } from "../../../shared/orca-card-lock.ts";
import { call, withCardDeadline } from "./orca-comment.ts";
import { probeFailure } from "../text.ts";
import { retirementCheckoutVeto } from "../retire-checkout.ts";
import type { RuntimeReceipt } from "./port.ts";

export async function orcaRetire(
  target: { id: string; path: string },
  expected: { comment: string; unread: boolean; branch?: string },
  timeoutMs: number,
  lock: CardLock = withCardLock,
): Promise<RuntimeReceipt> {
  let locked: { value: RuntimeReceipt } | null;
  try {
    locked = await withCardDeadline(
      target.path,
      timeoutMs,
      (remaining) => retireUnlocked(target, expected, remaining),
      lock,
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
  expected: { comment: string; unread: boolean; branch?: string },
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
  if (
    !isRecord(worktree) ||
    typeof worktree.comment !== "string" ||
    typeof worktree.isUnread !== "boolean" ||
    worktree.id !== target.id ||
    worktree.path !== target.path
  )
    return {
      ok: false,
      refused: true,
      detail: `${target.path}: no readable matching workspace, comment and unread mark; nothing removed`,
    };
  const comment = worktree.comment;
  const unread = worktree.isUnread;
  if (comment !== expected.comment || unread !== expected.unread)
    return {
      ok: false,
      refused: comment !== expected.comment,
      detail: `${target.path}: its comment or unread mark changed since the tick read it; nothing removed`,
    };
  if (remaining() <= 0)
    return {
      ok: false,
      detail: `${target.path}: the runtime's deadline passed before the removal; nothing removed`,
    };
  const safe = await safety(
    target,
    expected.branch ?? "jig-dispatch-notices",
    expected,
    remaining,
  );
  if (safe !== null)
    return {
      ok: false,
      refused: true,
      detail: `${target.path}: ${safe}; nothing removed`,
    };
  if (remaining() <= 0)
    return {
      ok: false,
      detail: "the runtime deadline passed; nothing removed",
    };
  const removed = await call(
    ["worktree", "rm", "--worktree", selector, "--delete-branch"],
    remaining(),
  );
  if (!removed.ok)
    return { ok: false, lost: removed.lost, detail: removed.why };
  return { ok: true, detail: `${target.path} removed with its branch` };
}

/** Refresh the workspace identity, sessions and Git facts under the removal deadline. */
async function safety(
  target: { id: string; path: string },
  branch: string,
  expected: { comment: string; unread: boolean },
  remaining: () => number,
): Promise<string | null> {
  if (remaining() <= 0) return "the runtime deadline passed";
  const head = await run(
    [
      "git",
      "-C",
      target.path,
      "-c",
      "core.fsmonitor=false",
      "symbolic-ref",
      "--short",
      "HEAD",
    ],
    { env: gitIdentityEnv(), timeoutSec: Math.max(0.001, remaining() / 1000) },
  );
  if (head.code !== 0) return probeFailure("git symbolic-ref", head);
  if (head.stdout.trim() !== branch) return "its branch changed";
  const veto = await retirementCheckoutVeto(target.path, remaining);
  if (veto !== null) return veto;
  if (remaining() <= 0) return "the runtime deadline passed";
  const listed = await call(["worktree", "ps", "--limit", "2000"], remaining());
  if (!listed.ok) return listed.why;
  return listingVeto(listed.result, target, branch, expected);
}

/** Validate the final whole runtime listing against the card the tick authorized. */
function listingVeto(
  ps: unknown,
  target: { id: string; path: string },
  branch: string,
  expected: { comment: string; unread: boolean },
): string | null {
  if (
    !isRecord(ps) ||
    ps.truncated !== false ||
    !isRecord(ps.hostScope) ||
    !Array.isArray(ps.hostScope.omittedHostIds) ||
    ps.hostScope.omittedHostIds.length !== 0 ||
    !Array.isArray(ps.worktrees)
  )
    return "the session listing is not whole";
  const rows = ps.worktrees.filter(
    (row) => isRecord(row) && row.path === target.path,
  );
  const row = rows.length === 1 ? rows[0] : null;
  if (
    !isRecord(row) ||
    row.worktreeId !== target.id ||
    row.branch !== `refs/heads/${branch}` ||
    !Array.isArray(row.agents) ||
    row.agents.length !== 0 ||
    row.unverifiableTerminalCount !== 0
  )
    return "its identity, branch, agents or terminals changed";
  if (row.comment !== expected.comment || row.unread !== expected.unread)
    return "its comment or unread mark changed before removal";
  return null;
}
