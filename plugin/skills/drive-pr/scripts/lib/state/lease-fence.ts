/**
 * The fences before an irreversible act outside drive state: a push, a
 * posted reply or answer, a label change. Each takes its lock and returns it
 * STILL HELD, for the caller to hold through the act, so nothing that
 * changes who drives can land between the check and the act.
 *
 * `assertRemoteMutationAllowed` allows the act only while no live lease on
 * the PR (every tree's) belongs to someone else: a pass whose lease was
 * cleared and taken over finds its successor's live lease and is refused,
 * whatever generation it was admitted on. It never trusts a proof that a
 * rival is merely a recycled pid: a comment has no undo, so only a
 * positively established absence of any live rival allows it.
 * `assertTreeMutationAllowed` is its tree-wide counterpart.
 */
import { fail } from "../cli.ts";
import { assertSameDatabase, type FenceContext } from "./lease-context.ts";
import {
  type Lease,
  leaseStaleMin,
  prRemoteMutationLock,
  treeLeaseLock,
  treeLeaseRef,
} from "./lease-model.ts";
import {
  ageLabel,
  isMine,
  leaseAlive,
  leaseHolderLabel,
  leaseLivenessHint,
  leaseRefsFor,
  leaseRefsForActor,
  readLease,
  readTreeLease,
} from "./lease-records.ts";
import { treeIsMine } from "./lease-tree.ts";
import {
  LOCK_ACQUIRE_MAX_SEC,
  LockAcquireTimeoutError,
  type PathLock,
} from "./lock.ts";

/**
 * May this session perform an irreversible remote mutation for `pr`? Takes
 * the PR's remote-mutation lock first (none when no PR is named:
 * `assert-post-allowed.ts`'s actor-wide check), refuses with exit 11 while a
 * live lease on the PR belongs to another holder, and with exit 1 when the
 * database is no longer the one the context was resolved on. Returns the
 * lock still held.
 */
export async function assertRemoteMutationAllowed(
  ctx: FenceContext,
  pr: string | null,
  label: string,
): Promise<PathLock | null> {
  const canonicalPr = pr === null ? null : BigInt(pr).toString();
  const remoteLock =
    canonicalPr === null ? null : await takeRemoteLock(ctx, canonicalPr, label);
  try {
    refuseLiveRivals(ctx, canonicalPr, label);
    assertSameDatabase(
      label,
      ctx,
      ctx.instance,
      "right before authorizing the post",
    );
  } catch (e) {
    remoteLock?.dispose();
    throw e;
  }
  return remoteLock;
}

/** The PR's remote-mutation lock, taken; exit 11 when another worktree's act holds it past the wait. */
async function takeRemoteLock(
  ctx: FenceContext,
  canonicalPr: string,
  label: string,
): Promise<PathLock> {
  const remoteLock = prRemoteMutationLock(ctx.stateDir, canonicalPr);
  try {
    await remoteLock.acquire(LOCK_ACQUIRE_MAX_SEC);
  } catch (e) {
    remoteLock.dispose();
    if (!(e instanceof LockAcquireTimeoutError)) throw e;
    fail(
      11,
      `${label}: PR #${canonicalPr} has an irreversible remote mutation (a push or a posted reply) in flight from another worktree, and it has not cleared yet.`,
      "",
      "Refusing to post rather than proceed alongside it — the identical",
      "cross-shipping hazard this PR-wide lock exists to close.",
      "This is not necessarily wedged: a push can legitimately run for the",
      "whole of $DRIVE_PR_PUSH_TIMEOUT (an hour, by default, pre-push hooks",
      "included), longer than this wait was bounded to. Retry once it",
      "completes.",
    );
  }
  return remoteLock;
}

/** Exit 11 when a live lease on the PR (or, with none named, of this actor) belongs to another holder. */
function refuseLiveRivals(
  ctx: FenceContext,
  canonicalPr: string | null,
  label: string,
): void {
  const candidates =
    canonicalPr === null
      ? leaseRefsForActor(ctx.stateDir, ctx.actor)
      : leaseRefsFor(ctx.stateDir, canonicalPr);
  for (const ref of candidates) {
    const held = readLease(ref);
    if (held === null) continue;
    if (isMine(held, ctx.session, ctx.actor) || !leaseAlive(held)) continue;
    refuseLiveHolder(label, ref.pr, held, held.actor === ctx.actor);
  }
}

function refuseLiveHolder(
  label: string,
  pr: string,
  held: Lease,
  sameTree: boolean,
): never {
  const where = sameTree
    ? "this working tree"
    : `a DIFFERENT working tree (${held.worktree === "" ? held.actor : held.worktree})`;
  return fail(
    11,
    `${label}: PR #${pr} is being driven from ${where} by another live holder (${leaseHolderLabel(held)}).`,
    `It took the lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
    "",
    sameTree
      ? "Refusing to post. Two sessions in ONE tree share one actor id, so both post"
      : "Refusing to post. A live session elsewhere is actively driving this PR, so",
    sameTree
      ? "their own outcome reply and every thread ends up with two — which is not"
      : "posting here doubles every outcome reply it makes from this point on — not",
    sameTree
      ? "repairable once the comments are up, and corrupts the reviewer-scoring"
      : "repairable once the comments are up, and it corrupts the reviewer-scoring",
    sameTree
      ? "sample they feed. Unlike drive state, a comment has no undo, so"
      : "sample it feeds. Unlike drive state, a comment has no",
    sameTree
      ? "this refusal comes BEFORE the mutation rather than after it."
      : "undo, so this refusal comes BEFORE the mutation rather than after it.",
    "",
    leaseLivenessHint(held),
    `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
    `Otherwise the lease clears itself once that holder has left drive state`,
    `untouched for ${leaseStaleMin()}m.`,
  );
}

/**
 * May this session still act on this tree's behalf? Passes when no tree
 * lease exists, when it is this caller's own (`treeIsMine`; with no PR
 * named, a sessionless presence record is never the caller's), or when its
 * holder has stopped driving; refuses (exit 11) a live other holder. Takes
 * the tree lease's lock and returns it still held, for the caller to hold
 * through its act (`guarded-push.ts` holds it through the push).
 */
export async function assertTreeMutationAllowed(
  ctx: FenceContext,
  pr: string | null,
  label: string,
): Promise<PathLock> {
  const lock = treeLeaseLock(ctx.stateDir, ctx.actor);
  await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
  try {
    const held = readTreeLease(treeLeaseRef(ctx.stateDir, ctx.actor));
    if (
      held !== null &&
      !treeIsMine(held, ctx.session, ctx.actor, pr) &&
      leaseAlive(held)
    ) {
      if (held.holder === "worktree") {
        fail(
          11,
          `${label}: this working tree already has a sessionless resolver active on PR #${held.pr}.`,
          `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
          "",
          "Refusing to post. A live sessionless resolver elsewhere in this tree is",
          "actively working, so proceeding here doubles every irreversible action",
          "from this point on — not repairable once it lands.",
          "",
          leaseLivenessHint(held),
          `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease <pr>`,
          "Otherwise the tree's presence record clears itself once that resolver",
          `has left drive state untouched for ${leaseStaleMin()}m.`,
        );
      }
      fail(
        11,
        `${label}: this working tree is being driven from a live session other than this one (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
        `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        "Refusing to post. A live session elsewhere in this tree is actively",
        "working, so proceeding here doubles every irreversible action from this",
        "point on — not repairable once it lands.",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease <pr>`,
        "Otherwise the tree lease clears itself once that session has left drive",
        `state untouched for ${leaseStaleMin()}m.`,
      );
    }
  } catch (e) {
    lock.dispose();
    throw e;
  }
  return lock;
}
