/** Git proof bound to the checkout identity that a coordinated removal will use. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { processWorktreeIdle } from "../process-worktrees.ts";
import type { Proof } from "../types.ts";
import {
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
