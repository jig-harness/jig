/** Release only the standalone Ready call's captured session lease generations. */
import { resolveActor } from "./state/actor.ts";
import { driveDb, inTransaction } from "./state/db.ts";
import {
  canonicalLeasePr,
  type Lease,
  leaseRef,
  treeLeaseRef,
  resolveSession,
  readLease,
  readTreeLease,
  removeLease,
  removeTreeLease,
} from "./state/lease.ts";
import { openStore } from "./state/store.ts";

/** Capture after winning the Ready claim; call only after its durable commit. */
export async function standaloneReadyCleanup(
  pr: string,
): Promise<() => Promise<void>> {
  const session = resolveSession("mark-ready.ts");
  if (session.source === "DRIVE_PR_SESSION") return async () => undefined;
  const store = await openStore(pr);
  const actor = await resolveActor();
  const ref = leaseRef(store.stateDir, pr, actor);
  const tree = treeLeaseRef(store.stateDir, actor);
  const owns = (held: Lease | null): boolean =>
    held !== null &&
    (session.source === "none"
      ? held.holder === "worktree"
      : held.holder === "session" &&
        held.pid === session.pid &&
        held.host === session.host);
  const captured = await store.locked(async () => ({
    lease: readLease(ref),
    tree: readTreeLease(tree),
  }));
  return async () => {
    await store.locked(async () =>
      inTransaction(driveDb(store.stateDir).db, () => {
        const lease = readLease(ref);
        if (
          owns(captured.lease) &&
          lease?.generation === captured.lease?.generation
        )
          removeLease(ref);
        const held = readTreeLease(tree);
        if (
          owns(captured.tree) &&
          captured.tree?.pr === canonicalLeasePr(pr) &&
          held?.pr === canonicalLeasePr(pr) &&
          held.generation === captured.tree.generation
        )
          removeTreeLease(tree);
      }),
    );
  };
}
