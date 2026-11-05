/** Session lease API: one session per worktree and one worktree per PR. Admission and mutation fences share the same rows. */
export {
  type Lease,
  type TreeLease,
  type Session,
  type LeaseRef,
  type TreeLeaseRef,
  leaseStaleMin,
  canonicalLeasePr,
  leaseRef,
  treeLeaseRef,
  leaseLabel,
  remoteLockName,
  prRemoteMutationLock,
  resolveSession,
  SESSION_LEASE_HELD_EXIT,
  DRIVE_HELD_ELSEWHERE_EXIT,
  type LeaseAdmission,
} from "./lease-model.ts";
export {
  readLease,
  readTreeLease,
  writeLease,
  writeTreeLease,
  removeLease,
  removeTreeLease,
  leaseRefsFor,
  leaseRefsForActor,
  liveLeasesFor,
  liveTreeLeaseFor,
  leaseAlive,
  leaseLivenessHint,
  leaseHolderLabel,
} from "./lease-records.ts";
export {
  assertNoForeignDriveNow,
  claimLease,
  assertLeaseUnchanged,
} from "./lease-admission.ts";
export {
  acquireSessionlessTreeGuardNow,
  acquireIdentifiedTreeGuardNow,
  assertTreeLeaseUnchanged,
} from "./lease-tree.ts";
export { type FenceContext, resolveFenceContext } from "./lease-context.ts";
export {
  assertRemoteMutationAllowed,
  assertTreeMutationAllowed,
} from "./lease-fence.ts";
export {
  clearLease,
  releaseSessionlessLease,
  clearAllLeases,
} from "./lease-cleanup.ts";
/**
 * What a driver exports to its passes as `$DRIVE_PR_STATE_DIR_IDENTITY`
 * beside its state directory: the instance id of the database that
 * directory stands for (`lease-context.ts` says what the fence does with it).
 */
export { driveDbInstance as stateDirIdentityToken } from "./db.ts";
