/**
 * The one local head the head-sync guard accepts while it differs from the
 * API head: the head a pass killed at its deadline left with unpushed
 * commits, which the driver witnessed after the kill and names to the next
 * gate (`--inherited-head`). Without it, that gate reads the unpushed
 * commits as replication lag and waits out its timeout, and the pass that
 * would push them never runs.
 */
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "../proc.ts";

/** A full object name: SHA-1 or SHA-256. */
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/**
 * Whether `localHead` is the witnessed inherited head on top of `apiHead`:
 * it equals the sha the driver named, and the API head is a strict ancestor
 * of it, so the difference is commits GitHub does not have yet rather than
 * a lag behind a push or another branch. Any other mismatch, or a probe
 * that cannot answer, is `false`, and the guard reports `HEAD_LAG` as
 * before. Measured in the driven tree (`$DRIVE_PR_WORKTREE`) when one is
 * named, as the local head itself is.
 */
export async function acceptsInheritedHead(
  apiHead: string,
  localHead: string,
  inheritedHead: string,
): Promise<boolean> {
  if (inheritedHead === "" || localHead !== inheritedHead) return false;
  if (apiHead === "" || apiHead === localHead) return false;
  const anchor = process.env.DRIVE_PR_WORKTREE;
  const res = await git(["merge-base", "--is-ancestor", apiHead, localHead], {
    stderr: "ignore",
    env: gitIdentityEnv(),
    timeoutSec: gitCallTimeoutSeconds(),
    ...(anchor ? { cwd: anchor } : {}),
  });
  return res.code === 0;
}
