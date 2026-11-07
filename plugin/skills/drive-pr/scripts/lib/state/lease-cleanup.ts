/**
 * Clear or release leases: `clear-lease` (this tree's), the sessionless
 * resolver's release, and `reset`'s sweep of every tree's lease on a PR,
 * which keeps a live foreign one. Each is one transaction, so nothing is
 * read in one state of the table and removed in another.
 */
import { resolveActor } from "./actor.ts";
import { driveDb, inTransaction } from "./db.ts";
import {
  canonicalLeasePr,
  type Lease,
  type LeaseRef,
  leaseRef,
  resolveSession,
  type TreeLease,
  treeLeaseRef,
} from "./lease-model.ts";
import {
  isRecycledPid,
  leaseAlive,
  leaseRefsFor,
  readLease,
  readTreeLease,
  removeLease,
  removeTreeLease,
} from "./lease-records.ts";

/** Drop this tree's lease on `pr` and its tree lease, live or not: the deliberate recovery command. */
export async function clearLease(
  stateDir: string,
  pr: string,
): Promise<{ lease: Lease | null; treeLease: TreeLease | null }> {
  const actor = await resolveActor();
  return inTransaction(driveDb(stateDir).db, () => {
    const ref = leaseRef(stateDir, pr, actor);
    const tree = treeLeaseRef(stateDir, actor);
    const lease = readLease(ref);
    const treeLease = readTreeLease(tree);
    removeLease(ref);
    removeTreeLease(tree);
    return { lease, treeLease };
  });
}

/**
 * Give back a sessionless resolver's presence records on `pr`: this tree's
 * per-PR lease when a `worktree` holder has it, and its tree lease when a
 * `worktree` holder has it for this PR. An identified session's lease is
 * never touched.
 */
export async function releaseSessionlessLease(
  stateDir: string,
  pr: string,
): Promise<{ lease: Lease | null; treeLease: TreeLease | null }> {
  const actor = await resolveActor();
  const canonicalPr = canonicalLeasePr(pr);
  return inTransaction(driveDb(stateDir).db, () => {
    const ref = leaseRef(stateDir, pr, actor);
    const held = readLease(ref);
    const lease = held?.holder === "worktree" ? held : null;
    if (lease !== null) removeLease(ref);
    const tree = treeLeaseRef(stateDir, actor);
    const treeHeld = readTreeLease(tree);
    const treeLease =
      treeHeld?.holder === "worktree" && treeHeld.pr === canonicalPr
        ? treeHeld
        : null;
    if (treeLease !== null) removeTreeLease(tree);
    return { lease, treeLease };
  });
}

/**
 * `reset`'s sweep of every tree's lease on `pr`. With `preserveLive`, a live
 * lease that is not `ownLease` (and whose pid was not provably recycled for
 * this session) is kept, and then nothing is removed: the sweep reports it,
 * so `reset` changes nothing while another tree is driving. `removed` names
 * each lease it removed.
 */
export async function clearAllLeases(
  stateDir: string,
  pr: string,
  ownLease: Lease | null,
  preserveLive = true,
): Promise<{ preservedForeign: Lease[]; removed: LeaseRef[] }> {
  const session = preserveLive ? resolveSession() : null;
  const actor = preserveLive ? await resolveActor() : "";
  return inTransaction(driveDb(stateDir).db, () => {
    const preservedForeign: Lease[] = [];
    const doomed: LeaseRef[] = [];
    for (const ref of leaseRefsFor(stateDir, pr)) {
      const held = readLease(ref);
      if (held === null) continue;
      if (
        preserveLive &&
        leaseAlive(held) &&
        !(session !== null && isRecycledPid(held, session, actor))
      ) {
        const isOwn =
          ownLease !== null &&
          held.actor === ownLease.actor &&
          held.pid === ownLease.pid &&
          held.host === ownLease.host &&
          held.generation === ownLease.generation;
        if (!isOwn) preservedForeign.push(held);
        continue;
      }
      doomed.push(ref);
    }
    if (preservedForeign.length > 0) return { preservedForeign, removed: [] };
    for (const ref of doomed) removeLease(ref);
    return { preservedForeign, removed: doomed };
  });
}
