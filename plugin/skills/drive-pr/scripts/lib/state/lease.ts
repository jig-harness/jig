/** Session lease API: one session per worktree and one worktree per PR. Admission and mutation fences share the same persisted records. */
export {
  type Lease,
  type TreeLease,
  type Session,
  leaseStaleMin,
  canonicalLeasePr,
  leasePathFor,
  treeLeasePathFor,
  prRemoteMutationLockPathFor,
  resolveSession,
  SESSION_LEASE_HELD_EXIT,
  DRIVE_HELD_ELSEWHERE_EXIT,
  type LeaseAdmission,
} from "./lease-model.ts";
export {
  readLease,
  parseLease,
  parseTreeLease,
  readTreeLease,
  liveLeasesFor,
  unreadableLeaseFilesFor,
  liveTreeLeaseFor,
  treeLeaseUnreadableAndFreshFor,
  leaseLivenessHint,
  leaseHolderLabel,
} from "./lease-records.ts";
export {
  stateDirIdentityToken,
  captureStateDirIdentityToken,
  parseDirIdentityToken,
  leaseFilesFor,
  leaseFilesForActor,
} from "./lease-files.ts";
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
export { resolveFenceContext } from "./lease-context.ts";
export {
  assertRemoteMutationAllowed,
  assertTreeMutationAllowed,
} from "./lease-fence.ts";
export {
  clearLease,
  releaseSessionlessLease,
  clearAllLeases,
} from "./lease-cleanup.ts";
