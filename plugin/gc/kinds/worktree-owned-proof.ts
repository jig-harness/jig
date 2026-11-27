/** Git proof bound to the checkout identity that a coordinated removal will use. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { processWorktreeIdle } from "../process-worktrees.ts";
import type { Proof } from "../types.ts";
import {
  orcaLiveness,
  runtimeWorktreeProof,
  unchangedSinceProof,
  worktreeIdentity,
  worktreeProof,
  type WorktreeIdentity,
  type WorktreePolicy,
} from "./worktree-proof.ts";

export async function ownedCheckoutProof(
  path: string,
  repository: string,
  policy: WorktreePolicy,
  idleDays: number,
  agentTool: boolean,
  processOwned: boolean,
): Promise<Outcome<{ proof: Proof; identity: WorktreeIdentity | null }>> {
  const seen =
    agentTool || processOwned ? await worktreeIdentity(path) : ok(null);
  if (!seen.ok) return seen;
  if (processOwned) {
    if (seen.value === null)
      return failed(
        "identity-missing",
        "the process owner has no checkout identity",
      );
    const idle = await processWorktreeIdle(path, repository, seen.value);
    if (!idle.ok) return idle;
  }
  const result = await worktreeProof(
    path,
    policy,
    idleDays,
    false,
    agentTool,
    processOwned,
  );
  if (!result.ok) return result;
  if (seen.value === null || result.value.state !== "dead")
    return ok({ proof: result.value, identity: null });
  const same = await unchangedSinceProof(path, seen.value);
  return same.ok ? ok({ proof: result.value, identity: seen.value }) : same;
}

/** Proof for a checkout Orca manages: the identity is read before the proof, so its own reads run inside it. */
export async function managedCheckoutProof(
  path: string,
  policy: WorktreePolicy,
  idleDays: number,
  orca: string,
): Promise<Outcome<{ proof: Proof; identity: WorktreeIdentity | null }>> {
  const seen = await worktreeIdentity(path);
  if (!seen.ok) return seen;
  const proof = await runtimeWorktreeProof(path, policy, idleDays, { orca });
  if (!proof.ok) return proof;
  if (proof.value.state !== "dead")
    return ok({ proof: proof.value, identity: null });
  const same = await unchangedSinceProof(path, seen.value);
  return same.ok ? ok({ proof: proof.value, identity: seen.value }) : same;
}

/**
 * The proof of a process-owned checkout Orca also lists (`dualListed`), once the process
 * owner's evidence and Git have judged it dead: Orca's registry must agree,
 * with no agent at work and no live terminal in it. Neither runtime's evidence
 * stands in for the other's, so a registry that cannot be read keeps the
 * checkout as unverified, naming Orca, and a proof that was not dead is left
 * as it is.
 */
export async function withOrcaEvidence(
  path: string,
  orca: string | undefined,
  dualListed: boolean,
  proved: { proof: Proof; identity: WorktreeIdentity | null },
): Promise<{ proof: Proof; identity: WorktreeIdentity | null }> {
  if (orca === undefined || !dualListed || proved.proof.state !== "dead")
    return proved;
  const registry = await orcaLiveness(orca, path, true);
  if (registry !== null) return { proof: registry, identity: null };
  return {
    proof: {
      ...proved.proof,
      reason: `${proved.proof.reason}; Orca also lists it, and its registry shows no agent or live terminal in it`,
    },
    identity: proved.identity,
  };
}
