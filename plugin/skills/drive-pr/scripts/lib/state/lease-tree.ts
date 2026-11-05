/**
 * The tree lease: admit at most one live session per WORKING TREE, whichever
 * PR it drives, so two sessions driving two different PRs cannot edit,
 * commit and push one checkout over each other. An identified session claims
 * a `session`-held tree lease; a sessionless resolver claims a
 * `worktree`-held presence record. The guards here take the tree lease's own
 * lock (`lease-model.ts`'s `treeLeaseLock`) and hold it through the mutation
 * they admit, so a takeover cannot land between the check and the act.
 */
import { hostname } from "node:os";
import { fail } from "../cli.ts";
import { resolveActor } from "./actor.ts";
import { driveDb, inTransaction } from "./db.ts";
import {
  canonicalLeasePr,
  leaseStaleMin,
  renewAfterMs,
  type Session,
  type TreeLease,
  treeLeaseLock,
  treeLeaseRef,
} from "./lease-model.ts";
import {
  ageLabel,
  isMine,
  isRecycledPid,
  leaseAlive,
  leaseForClaim,
  leaseHolderLabel,
  leaseLivenessHint,
  newRevision,
  readTreeLease,
  removeTreeLease,
  sameAdmission,
  writeTreeLease,
} from "./lease-records.ts";
import { createLock, LOCK_ACQUIRE_MAX_SEC, type PathLock } from "./lock.ts";

/** Refuse when a live session other than this sessionless caller holds the tree. */
function checkNoForeignSessionInTree(held: TreeLease | null): void {
  if (held === null || !leaseAlive(held)) return;
  if (held.holder === "worktree") {
    fail(
      11,
      `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr}.`,
      `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "This process could not identify its own session ($DRIVE_PR_SESSION and",
      "$CLAUDE_PID are both unset or dead), and a live sessionless resolver",
      "already holds this tree — mutating anyway would run beside it, in the",
      "same checkout.",
      "",
      leaseLivenessHint(held),
    );
  }
  fail(
    11,
    `drive-state.ts: this working tree is already being driven by a live session (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
    `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
    "",
    "This process could not identify its own session ($DRIVE_PR_SESSION and",
    "$CLAUDE_PID are both unset or dead), so it can take no lease of its own —",
    "but a live one already held here means mutating anyway would run beside",
    "it, in the same checkout.",
    "",
    leaseLivenessHint(held),
  );
}

/**
 * For a sessionless mutation: take the tree lease's lock, refuse when a live
 * session holds the tree, and return the lock STILL HELD, for the caller to
 * hold through its mutation.
 */
export async function acquireSessionlessTreeGuardNow(
  stateDir: string,
): Promise<PathLock> {
  const actor = await resolveActor();
  const lock = treeLeaseLock(stateDir, actor);
  await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
  try {
    checkNoForeignSessionInTree(readTreeLease(treeLeaseRef(stateDir, actor)));
  } catch (e) {
    lock.dispose();
    throw e;
  }
  return lock;
}

/**
 * For an identified mutation: take the tree lease's lock, refuse when the
 * tree lease is no longer the one this command was admitted on, and return
 * the lock STILL HELD.
 */
export async function acquireIdentifiedTreeGuardNow(
  stateDir: string,
  actor: string,
  admitted: TreeLease,
): Promise<PathLock> {
  const lock = treeLeaseLock(stateDir, actor);
  await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
  try {
    assertTreeLeaseUnchanged(stateDir, actor, admitted);
  } catch (e) {
    lock.dispose();
    throw e;
  }
  return lock;
}

/** What a tree-lease claim wrote over what, for a rollback if the per-PR claim then fails. */
export interface TreeLeaseClaim {
  lease: TreeLease;
  /** The lease this claim wrote; `null` when it renewed nothing because the lease was fresh. */
  wrote: TreeLease | null;
  /** The lease it replaced; `null` when there was none. */
  before: TreeLease | null;
}

/** Whether `held` is this caller's own tree lease. */
export function treeIsMine(
  held: TreeLease,
  session: Session,
  actor: string,
  pr: string | null,
): boolean {
  if (held.holder === "worktree") {
    return pr !== null && held.pr === canonicalLeasePr(pr);
  }
  return isMine(held, session, actor);
}

/** A claim that needs no write: the lease is this holder's, for this PR, renewed just now. */
function freshTreeClaim(
  seen: TreeLease | null,
  holder: TreeLease["holder"],
  pr: string,
  owns: (seen: TreeLease) => boolean,
): TreeLeaseClaim | null {
  if (
    seen === null ||
    seen.holder !== holder ||
    !owns(seen) ||
    seen.pr !== pr ||
    !(Date.now() - Date.parse(seen.lastSeen) < renewAfterMs())
  )
    return null;
  return { lease: seen, wrote: null, before: null };
}

/**
 * Run `underLock` holding the store's per-PR lock when `holdState`: a claim
 * that mints a new generation takes it, so a mutation already admitted on
 * the old generation cannot run between its fence and its write.
 */
async function withTreeStateLock(
  stateDir: string,
  pr: string,
  holdState: boolean,
  underLock: (holdState: boolean) => Promise<TreeLeaseClaim>,
): Promise<TreeLeaseClaim> {
  const stateLock = holdState
    ? createLock(
        stateDir,
        `drive-pr-${canonicalLeasePr(pr)}`,
        "drive-state.ts",
        pr,
      )
    : null;
  if (stateLock) await stateLock.acquire();
  try {
    return await underLock(holdState);
  } finally {
    stateLock?.dispose();
  }
}

/**
 * Hold the tree lease's lock and decide over its row in one transaction:
 * `decide` returns the claim, or `"retry"` to start over holding the store's
 * lock.
 */
async function underTreeLock(
  stateDir: string,
  actor: string,
  decide: (held: TreeLease | null) => TreeLeaseClaim | "retry",
): Promise<TreeLeaseClaim | "retry"> {
  const lock = treeLeaseLock(stateDir, actor);
  await lock.acquire();
  try {
    return inTransaction(driveDb(stateDir).db, () =>
      decide(readTreeLease(treeLeaseRef(stateDir, actor))),
    );
  } finally {
    lock.dispose();
  }
}

/**
 * Claim the tree lease: holding the store's lock first when the claim mints
 * a new generation, decide under the tree lease's own lock, and start over
 * holding the store's lock when `decide` finds the lease changed since it
 * was first read (`"retry"`).
 */
async function claimTree(
  stateDir: string,
  actor: string,
  pr: string,
  mintsNewGeneration: boolean,
  decide: (
    held: TreeLease | null,
    holdState: boolean,
  ) => TreeLeaseClaim | "retry",
): Promise<TreeLeaseClaim> {
  const run = async (holdState: boolean): Promise<TreeLeaseClaim> => {
    const claim = await underTreeLock(stateDir, actor, (held) =>
      decide(held, holdState),
    );
    return claim === "retry"
      ? await withTreeStateLock(stateDir, pr, true, run)
      : claim;
  };
  return await withTreeStateLock(stateDir, pr, mintsNewGeneration, run);
}

/** Write `lease` as this claim's, remembering what it replaced. */
function writeTreeClaim(
  stateDir: string,
  actor: string,
  lease: TreeLease,
  before: TreeLease | null,
): TreeLeaseClaim {
  writeTreeLease(treeLeaseRef(stateDir, actor), lease);
  return { lease, wrote: lease, before };
}

/** Claim this tree's lease for an identified session driving `pr`. */
export async function claimTreeLease(
  stateDir: string,
  actor: string,
  session: Session,
  worktree: string,
  pr: string,
  command: string,
): Promise<TreeLeaseClaim> {
  const canonicalPr = canonicalLeasePr(pr);
  const seen = readTreeLease(treeLeaseRef(stateDir, actor));
  const fresh = freshTreeClaim(seen, "session", canonicalPr, (s) =>
    treeIsMine(s, session, actor, pr),
  );
  if (fresh !== null) return fresh;
  const mintsNewGeneration =
    seen === null ||
    (!treeIsMine(seen, session, actor, pr) &&
      (isRecycledPid(seen, session, actor) || !leaseAlive(seen)));
  return await claimTree(
    stateDir,
    actor,
    pr,
    mintsNewGeneration,
    (held, holdState) => {
      const mine = held !== null && treeIsMine(held, session, actor, pr);
      if (
        !holdState &&
        (held === null ||
          (!mine && (!leaseAlive(held) || isRecycledPid(held, session, actor))))
      )
        return "retry";
      if (held !== null && !mine)
        reportIdentifiedTreeTakeover(held, session, actor, pr, canonicalPr);
      const lease: TreeLease = {
        ...leaseForClaim(
          "session",
          session,
          actor,
          worktree,
          command,
          held,
          mine,
          stateDir,
        ),
        pr: canonicalPr,
        revision: newRevision(),
      };
      return writeTreeClaim(stateDir, actor, lease, held);
    },
  );
}

/**
 * Undo a tree-lease claim whose per-PR claim then failed: put back what it
 * replaced, but only while the lease is still the one this claim wrote (its
 * `revision`), never a later sibling's.
 */
export async function rollbackTreeLease(
  stateDir: string,
  actor: string,
  wrote: TreeLease,
  before: TreeLease | null,
): Promise<void> {
  const lock = treeLeaseLock(stateDir, actor);
  await lock.acquire();
  try {
    inTransaction(driveDb(stateDir).db, () => {
      const ref = treeLeaseRef(stateDir, actor);
      const current = readTreeLease(ref);
      if (current === null || current.revision !== wrote.revision) return;
      if (before === null) removeTreeLease(ref);
      else writeTreeLease(ref, before);
    });
  } finally {
    lock.dispose();
  }
}

/** Claim this tree's presence record for a sessionless resolver driving `pr`. */
export async function claimSessionlessTreeLease(
  stateDir: string,
  actor: string,
  worktree: string,
  pr: string,
  command: string,
): Promise<TreeLeaseClaim> {
  const canonicalPr = canonicalLeasePr(pr);
  const seen = readTreeLease(treeLeaseRef(stateDir, actor));
  const fresh = freshTreeClaim(seen, "worktree", canonicalPr, () => true);
  if (fresh !== null) return fresh;
  const mintsNewGeneration =
    seen === null ||
    (!(seen.holder === "worktree" && seen.pr === canonicalPr) &&
      !leaseAlive(seen));
  return await claimTree(
    stateDir,
    actor,
    pr,
    mintsNewGeneration,
    (held, holdState) => {
      const samePr =
        held !== null && held.holder === "worktree" && held.pr === canonicalPr;
      if (!holdState && (held === null || (!samePr && !leaseAlive(held))))
        return "retry";
      if (held !== null && !samePr)
        reportSessionlessTreeTakeover(held, pr, canonicalPr);
      const lease: TreeLease = {
        ...leaseForClaim(
          "worktree",
          { pid: 0, host: hostname(), sessionStarted: "", source: "none" },
          actor,
          worktree,
          command,
          held,
          samePr,
          stateDir,
        ),
        pr: canonicalPr,
        revision: newRevision(),
      };
      return writeTreeClaim(stateDir, actor, lease, held);
    },
  );
}

/** Refuse when the tree lease is no longer the generation `admitted` was. */
export function assertTreeLeaseUnchanged(
  stateDir: string,
  actor: string,
  admitted: TreeLease,
): void {
  const held = readTreeLease(treeLeaseRef(stateDir, actor));
  if (sameAdmission(held, admitted)) return;
  fail(
    11,
    `drive-state.ts: this working tree's TREE lease (admitted for PR #${admitted.pr}) was taken over while this command waited for the state lock.`,
    held === null
      ? "The lease this command was admitted on is gone."
      : `It now belongs to ${leaseHolderLabel(held)} (since ${held.startedAt}, PR #${held.pr}).`,
    "",
    "Refusing to mutate: the session that took it over may already be working,",
    "and two writers in one tree can cross-ship uncommitted edits.",
    "Nothing was written.",
    "",
    "Re-run the command if you still hold the drive; the takeover is only",
    "authoritative if that other session is genuinely driving this tree.",
  );
}

function reportIdentifiedTreeTakeover(
  held: TreeLease,
  session: Session,
  actor: string,
  pr: string,
  canonicalPr: string,
): void {
  if (leaseAlive(held) && !isRecycledPid(held, session, actor)) {
    if (held.holder === "worktree") {
      fail(
        11,
        `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr} — this command is for PR #${canonicalPr}.`,
        `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        "This identified session and that sessionless resolver share the same",
        "checkout: they can edit and commit the same files concurrently, and",
        "one resolver's uncommitted changes can be pushed to the other's PR.",
        "Refusing to be the second.",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
        "Otherwise the tree's presence record clears itself once that resolver",
        `has left drive state untouched for ${leaseStaleMin()}m.`,
      );
    }
    fail(
      11,
      `drive-state.ts: this working tree is already being driven by another live session (pid ${held.pid} on ${held.host || "this host"}) — it is on PR #${held.pr}, this command is for PR #${canonicalPr}.`,
      `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Two sessions in ONE tree — even driving different PRs — share the same",
      "checkout: they can edit and commit the same files concurrently, and one",
      "session's uncommitted changes can be pushed to the other's PR. Refusing",
      "to be the second.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
      "Otherwise the tree lease clears itself once that session has left drive",
      `state untouched for ${leaseStaleMin()}m.`,
    );
  }
  console.error(
    held.holder === "worktree"
      ? `drive-state.ts: took over an abandoned TREE presence record (a sessionless resolver, gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`
      : isRecycledPid(held, session, actor)
        ? `drive-state.ts: took over a TREE lease whose pid (${held.pid}) the OS has recycled for this new, unrelated session (previous session last mutated drive state ${ageLabel(held.lastSeen)}, was on PR #${held.pr}).`
        : `drive-state.ts: took over an abandoned TREE lease (session pid ${held.pid} is gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`,
  );
}

function reportSessionlessTreeTakeover(
  held: TreeLease,
  pr: string,
  canonicalPr: string,
): void {
  if (leaseAlive(held)) {
    if (held.holder === "session") {
      fail(
        11,
        `drive-state.ts: this working tree is already being driven by a live session (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
        `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        "This process could not identify its own session ($DRIVE_PR_SESSION and",
        "$CLAUDE_PID are both unset or dead), and a live IDENTIFIED session",
        "already holds this tree — writing a sessionless presence record over",
        "it would only downgrade what that session already represents, so this",
        "claims nothing here.",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
        "Otherwise the tree lease clears itself once that session has left drive",
        `state untouched for ${leaseStaleMin()}m.`,
      );
    }
    fail(
      11,
      `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr} — this command is for PR #${canonicalPr}.`,
      `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Two sessionless resolvers in ONE tree — even driving different PRs —",
      "share the same checkout: they can edit and commit the same files",
      "concurrently, and one resolver's uncommitted changes can be pushed to",
      "the other PR. Refusing to be the second.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
      "Otherwise the tree's presence record clears itself once that resolver",
      `has left drive state untouched for ${leaseStaleMin()}m.`,
    );
  }
  console.error(
    held.holder === "session"
      ? `drive-state.ts: took over a TREE lease whose session (pid ${held.pid}) is gone or idle since ${held.lastSeen} (was on PR #${held.pr}).`
      : `drive-state.ts: took over an abandoned TREE presence record (a sessionless resolver, gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`,
  );
}
