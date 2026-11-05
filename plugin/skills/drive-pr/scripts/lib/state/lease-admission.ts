/**
 * Admit one tree per PR, and one session per tree and PR, before any
 * mutation of drive state: `claimLease` takes or renews the per-PR lease
 * and the tree lease together, and refuses (exit 11 within this tree, exit 13
 * from another) while another live holder has them. `assertLeaseUnchanged`
 * is the fence a command runs once it holds the store's lock: the lease it
 * was admitted on must still be there, at the same generation.
 */
import { fail } from "../cli.ts";
import { resolveActor, worktreeRoot } from "./actor.ts";
import { driveDb, inTransaction } from "./db.ts";
import {
  canonicalLeasePr,
  DRIVE_HELD_ELSEWHERE_EXIT,
  type Lease,
  type LeaseAdmission,
  leaseRef,
  leaseStaleMin,
  prRemoteMutationLock,
  renewAfterMs,
  resolveSession,
  type Session,
} from "./lease-model.ts";
import {
  ageLabel,
  isMine,
  isRecycledPid,
  leaseAlive,
  leaseForClaim,
  leaseFreshMarginMs,
  leaseHolderLabel,
  leaseLivenessHint,
  liveLeasesFor,
  readLease,
  sameAdmission,
  writeLease,
} from "./lease-records.ts";
import {
  claimSessionlessTreeLease,
  claimTreeLease,
  rollbackTreeLease,
  type TreeLeaseClaim,
} from "./lease-tree.ts";
import {
  createLock,
  LOCK_ACQUIRE_MAX_SEC,
  LockAcquireTimeoutError,
  lockHeartbeatMs,
  type PathLock,
} from "./lock.ts";

/** For a caller with no lease of its own to take: refuse while another tree drives `pr`. */
export async function assertNoForeignDriveNow(
  stateDir: string,
  pr: string,
): Promise<void> {
  assertNoForeignDrive(stateDir, pr, await resolveActor());
}

/**
 * Refuse (exit 13) while a live session in ANOTHER working tree holds a
 * lease on `pr`. A lease whose pid the OS provably recycled for this very
 * session does not count.
 */
function assertNoForeignDrive(
  stateDir: string,
  pr: string,
  actor: string,
): void {
  const session = resolveSession();
  const foreign = liveLeasesFor(stateDir, pr).filter(
    (l) => l.actor !== actor && !isRecycledPid(l, session, actor),
  );
  const l = foreign[0];
  if (l === undefined) return;
  const where = l.worktree === "" ? l.actor : `${l.worktree} (${l.actor})`;
  fail(
    DRIVE_HELD_ELSEWHERE_EXIT,
    `drive-state.ts: PR #${pr} is already being driven from ANOTHER working tree — ${where}.`,
    `That tree is held by ${leaseHolderLabel(l)}; it took the lease at ${l.startedAt} and last mutated drive state ${ageLabel(l.lastSeen)} ('${l.command}').`,
    ...(foreign.length > 1
      ? [
          `(${foreign.length} live foreign leases in total — run 'drive-state.ts lease ${pr} --all' to see them.)`,
        ]
      : []),
    "",
    "Two resolvers on one PR put TWO outcome replies on every thread they both",
    "reach, which is not repairable once posted and corrupts the reviewer-scoring",
    "sample. Refusing to be the second.",
    "",
    "Nothing here stops this tree READING the drive: get, held, held-keys,",
    "parked-keys, verified, rounds and lease are all ungated. Only mutating this",
    "PR's drive state — which is the same thing as replying to its threads — is.",
    "",
    leaseLivenessHint(l),
    `If it is gone, or you are taking the PR over deliberately:  drive-state.ts clear-lease ${pr} --all`,
    `Otherwise the lease clears itself once that tree has left drive state`,
    `untouched for ${leaseStaleMin()}m, and this tree is admitted with no further action.`,
  );
}

/**
 * Take or renew this session's lease on (this tree, `pr`) and its tree
 * lease, in one admission. A lease this session holds and renewed within
 * `renewAfterMs` is returned as it is. A takeover (no lease, or a dead or
 * recycled holder's), or a renewal past the fresh margin, holds the PR's
 * remote-mutation lock and the store's lock while it checks every tree's
 * lease and writes its own, so it can neither be admitted beside a push in
 * flight nor between another command's fence and its write.
 */
export async function claimLease(
  stateDir: string,
  pr: string,
  command: string,
): Promise<LeaseAdmission> {
  const session = resolveSession();
  const actor = await resolveActor();
  const worktree = await worktreeRoot();
  if (session.source === "none") {
    // A sessionless resolver defers to a live identified session of its own
    // tree rather than writing a presence record beside it.
    assertNoForeignDrive(stateDir, pr, actor);
    const own = readLease(leaseRef(stateDir, pr, actor));
    if (own !== null && own.holder === "session" && leaseAlive(own)) {
      return { lease: null, treeLease: null };
    }
    const treeClaim = await claimSessionlessTreeLease(
      stateDir,
      actor,
      worktree,
      pr,
      command,
    );
    let lease: Lease;
    try {
      lease = await claimPrLease();
    } catch (err) {
      await rollbackFailedTreeClaim(treeClaim, pr, "presence record");
      throw err;
    }
    return { lease, treeLease: treeClaim.lease };
  }
  const treeClaim = await claimTreeLease(
    stateDir,
    actor,
    session,
    worktree,
    pr,
    command,
  );
  let lease: Lease;
  try {
    lease = await claimPrLease();
  } catch (err) {
    await rollbackFailedTreeClaim(treeClaim, pr, "lease");
    throw err;
  }
  return { lease, treeLease: treeClaim.lease };

  async function rollbackFailedTreeClaim(
    treeClaim: TreeLeaseClaim,
    pr: string,
    description: "presence record" | "lease",
  ): Promise<void> {
    if (treeClaim.wrote === null) return;
    try {
      await rollbackTreeLease(
        stateDir,
        actor,
        treeClaim.wrote,
        treeClaim.before,
      );
    } catch (rollbackErr) {
      console.error(
        `drive-state.ts: could not roll back this tree's TREE ${description} after a failed admission (${(rollbackErr as Error)?.message ?? rollbackErr}).`,
      );
      console.error(
        `If it now wedges another session, clear it deliberately:  drive-state.ts clear-lease ${pr}`,
      );
    }
  }

  async function claimPrLease(): Promise<Lease> {
    const ref = leaseRef(stateDir, pr, actor);
    const holder: Lease["holder"] =
      session.source === "none" ? "worktree" : "session";
    const seen = readLease(ref);
    if (
      seen !== null &&
      isMine(seen, session, actor) &&
      seen.holder === holder &&
      Date.now() - Date.parse(seen.lastSeen) < renewAfterMs()
    ) {
      return seen;
    }
    const mintsNewGeneration =
      seen === null ||
      (!isMine(seen, session, actor) &&
        (isRecycledPid(seen, session, actor) || !leaseAlive(seen)));
    const quietPastMargin =
      seen !== null &&
      Date.now() - Date.parse(seen.lastSeen) > leaseFreshMarginMs();
    return await withLeaseLocks(mintsNewGeneration || quietPastMargin);

    async function withLeaseLocks(holdState: boolean): Promise<Lease> {
      const remoteLock = holdState ? prRemoteMutationLock(stateDir, pr) : null;
      await acquireClaimRemoteLock(remoteLock, pr);
      const heartbeat =
        remoteLock === null
          ? null
          : setInterval(() => remoteLock.touch(), lockHeartbeatMs());
      const stateLock = holdState
        ? createLock(
            stateDir,
            `drive-pr-${canonicalLeasePr(pr)}`,
            "drive-state.ts",
            pr,
          )
        : null;
      try {
        if (stateLock) await stateLock.acquire();
        const decided = inTransaction(driveDb(stateDir).db, () =>
          decide(holdState),
        );
        return decided === "retry" ? await withLeaseLocks(true) : decided;
      } finally {
        if (heartbeat !== null) clearInterval(heartbeat);
        stateLock?.dispose();
        remoteLock?.dispose();
      }
    }

    function decide(holdState: boolean): Lease | "retry" {
      const held = readLease(ref);
      const mine = held !== null && isMine(held, session, actor);
      if (
        !holdState &&
        (held === null ||
          (!mine &&
            (!leaseAlive(held) || isRecycledPid(held, session, actor))) ||
          Date.now() - Date.parse(held.lastSeen) > leaseFreshMarginMs())
      )
        return "retry";
      if (held !== null && !mine) reportPrTakeover(held, session, actor, pr);
      if (holdState) assertNoForeignDrive(stateDir, pr, actor);
      const lease = leaseForClaim(
        holder,
        session,
        actor,
        worktree,
        command,
        held,
        mine,
        stateDir,
      );
      writeLease(ref, lease);
      return lease;
    }
  }
}

/**
 * The fence a mutating command runs inside the store's lock: the lease it
 * was admitted on must still be there, held by the same session at the same
 * generation (`liveness.ts`'s `fence`). A later generation means a takeover
 * or a `clear-lease` and a re-admission happened while it waited; none means
 * a `reset` or a `clear-lease` swept it. Either way nothing is written.
 */
export function assertLeaseUnchanged(
  stateDir: string,
  pr: string,
  admitted: Lease,
): void {
  const held = readLease(leaseRef(stateDir, pr, admitted.actor));
  if (sameAdmission(held, admitted)) return;
  fail(
    11,
    `drive-state.ts: PR #${pr}'s drive lease was taken over while this command waited for the state lock.`,
    held === null
      ? "The lease this command was admitted on is gone — swept by `reset`, or dropped by `clear-lease`."
      : `It now belongs to ${leaseHolderLabel(held)} (since ${held.startedAt}).`,
    "",
    "Refusing to mutate: the session that took it over may already be working,",
    "and two writers under one actor overwrite each other’s holds and",
    "double-reply every thread. Nothing was written.",
    "",
    "Re-run the command if you still hold the drive; the takeover is only",
    "authoritative if that other session is genuinely driving this PR.",
  );
}

/** Refuse a takeover of a live session's lease in this tree; report one of an abandoned lease. */
function reportPrTakeover(
  held: Lease,
  session: Session,
  actor: string,
  pr: string,
): void {
  if (leaseAlive(held) && !isRecycledPid(held, session, actor)) {
    fail(
      11,
      `drive-state.ts: PR #${pr} is already being driven from this working tree by another session (${leaseHolderLabel(held)}).`,
      `It took the lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Two drivers in ONE tree share one actor id, so their holds overwrite each",
      "other and every thread ends up with two outcome replies — which is not",
      "repairable once posted. Refusing to be the second.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
      `Otherwise the lease clears itself once that session has left drive state`,
      `untouched for ${leaseStaleMin()}m.`,
    );
  }
  console.error(
    isRecycledPid(held, session, actor)
      ? `drive-state.ts: took over a drive lease on PR #${pr} whose pid (${held.pid}) the OS has recycled for this new, unrelated session (previous session last mutated drive state ${ageLabel(held.lastSeen)}).`
      : `drive-state.ts: took over an abandoned drive lease on PR #${pr} (${leaseHolderLabel(held)} — gone or idle since ${held.lastSeen}).`,
  );
}

/** Take the PR's remote-mutation lock for a claim, refusing (exit 11) while a push or a post holds it. */
async function acquireClaimRemoteLock(
  remoteLock: PathLock | null,
  pr: string,
): Promise<void> {
  if (remoteLock === null) return;
  try {
    await remoteLock.acquire(LOCK_ACQUIRE_MAX_SEC);
  } catch (e) {
    remoteLock.dispose();
    if (!(e instanceof LockAcquireTimeoutError)) throw e;
    fail(
      11,
      `drive-state.ts: PR #${pr} has an irreversible remote mutation (a push or a posted reply) in flight from another worktree, and it has not cleared yet.`,
      "",
      "Refusing this claim rather than admit alongside it — the identical",
      "cross-shipping hazard this PR-wide lock exists to close.",
      "This is not necessarily wedged: a push can legitimately run for the",
      "whole of $DRIVE_PR_PUSH_TIMEOUT (an hour, by default, pre-push hooks",
      "included), longer than this wait was bounded to. Retry once it",
      "completes.",
    );
  }
}
