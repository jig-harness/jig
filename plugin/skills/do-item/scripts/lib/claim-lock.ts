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
  // Claims for one tracker issue share a short lock across worktrees. The
  // caller supplies the canonical adapter/team/issue identity, so unrelated
  // repositories do not serialize each other.
  const root = join(homedir(), ".local", "state", "jig", "tracker-claims");
  const safeKey = Buffer.from(key).toString("base64url");
  const result = await withFileLock(join(root, safeKey), body, {
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
