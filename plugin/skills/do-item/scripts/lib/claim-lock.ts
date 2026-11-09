/** Competing Jig claims on this host share one mutex across worktrees. */
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../../../shared/file-lock.ts";
import type { ClaimResult } from "./claim.ts";

/** This machine-local lock is not a tracker conditional write or a cross-host lease. */
export async function withClaimLock(
  key: string,
  body: () => Promise<ClaimResult>,
): Promise<ClaimResult> {
  // All repository claims share a short lock. This avoids key aliases and
  // differing worktree paths accidentally making two locks for one issue.
  const root = join(homedir(), ".local", "state", "jig", "tracker-claims");
  const result = await withFileLock(join(root, "all-claims"), body, {
    root,
    name: "claim",
    waitMs: 5000,
  });
  return (
    result?.value ?? {
      outcome: "refused",
      issue: key,
      why: "assigned",
      reason:
        "another Jig claim holds this host's claim lock; refresh the queue",
    }
  );
}
