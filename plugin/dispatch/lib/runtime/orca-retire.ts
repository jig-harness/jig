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
import { gitIdentityEnv, run } from "../../../shared/proc.ts";
import { isRecord } from "../../../shared/guards.ts";
import { type CardLock, withCardLock } from "../../../shared/orca-card-lock.ts";
import { call } from "./orca-comment.ts";
import { probeFailure } from "../text.ts";
import type { RuntimeReceipt } from "./port.ts";

export async function orcaRetire(
  target: { id: string; path: string },
  expected: { comment: string; unread: boolean; branch?: string },
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
      detail: `${target.path}: no readable matching workspace, comment and unread mark; nothing removed`,
    };
  const comment = worktree.comment;
  const unread = worktree.isUnread;
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
  const safe = await safety(
    target,
    expected.branch ?? "jig-dispatch-notices",
    remaining,
  );
  if (safe !== null)
    return { ok: false, detail: `${target.path}: ${safe}; nothing removed` };
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
  remaining: () => number,
): Promise<string | null> {
  for (const [args, accepts, why] of [
    [
      ["symbolic-ref", "--short", "HEAD"],
      (text: string) => text.trim() === branch,
      "its branch changed",
    ],
    [
      ["status", "--porcelain"],
      (text: string) => text.trim() === "",
      "git reports changes in it",
    ],
    [
      ["branch", "-r", "--contains", "HEAD"],
      (text: string) => text.trim() !== "",
      "its commit is on no remote branch",
    ],
  ] as const) {
    if (remaining() <= 0) return "the runtime deadline passed";
    const done = await run(
      ["git", "-C", target.path, "-c", "core.fsmonitor=false", ...args],
      {
        env: gitIdentityEnv(),
        timeoutSec: Math.max(0.001, remaining() / 1000),
      },
    );
    if (done.code !== 0) return probeFailure(`git ${args.join(" ")}`, done);
    if (!accepts(done.stdout)) return why;
  }
  const listed = await call(["worktree", "ps", "--limit", "2000"], remaining());
  if (!listed.ok) return listed.why;
  const ps = listed.result;
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
  return null;
}
