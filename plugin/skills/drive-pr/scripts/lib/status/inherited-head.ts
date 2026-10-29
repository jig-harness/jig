/**
 * The one local head the head-sync guard accepts while it differs from the
 * API head: the head a pass killed at its deadline left with unpushed
 * commits, which the driver witnessed after the kill and names to the next
 * gate (`--inherited-head`). Without it, that gate reads the unpushed
 * commits as replication lag and waits out its timeout, and the pass that
 * would push them never runs.
 */
import { fail } from "../cli.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "../proc.ts";

/** A full object name: SHA-1 or SHA-256. */
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/**
 * Remove `--inherited-head SHA` from `argv` and return SHA (`''` when the
 * flag is absent); a missing or partial SHA is a usage error.
 */
export function takeInheritedHead(argv: string[]): string {
  const at = argv.indexOf("--inherited-head");
  if (at < 0) return "";
  const [, value = ""] = argv.splice(at, 2);
  if (!isFullSha(value)) fail(2, "--inherited-head takes a full commit SHA");
  return value;
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

/** What the head-sync guard reads: in step, an accepted inherited head, or lag. */
export type HeadSync = "in-sync" | "inherited" | "lagging";

/** The head-sync guard's reading of the local head against the API head. */
export async function headSyncState(
  headSync: boolean,
  apiHead: string,
  localHead: string,
  inheritedHead: string,
): Promise<HeadSync> {
  // On the PR head itself, the killed pass left uncommitted edits only: the
  // round that settles them is still owed, whether or not the local head is
  // compared at all (`--no-head-sync` leaves it unread).
  const local = localHead === "" ? apiHead : localHead;
  if (inheritedHead !== "" && apiHead === inheritedHead && local === apiHead)
    return "inherited";
  if (!headSync || apiHead === localHead) return "in-sync";
  return (await acceptsInheritedHead(apiHead, localHead, inheritedHead))
    ? "inherited"
    : "lagging";
}

/**
 * Whether a gate may end the drive (converged, parked or conflicting): only
 * with no live work, and never over an inherited head, whose commits a round
 * must push first, unless the PR conflicts, which its own repair round
 * handles.
 */
export function mayEndWithoutWork(
  liveWork: number,
  sync: HeadSync,
  conflicting: boolean,
): boolean {
  return liveWork <= 0 && (sync !== "inherited" || conflicting);
}

/** What a ready round's reason adds when it pushes an inherited head. */
export function inheritedReason(sync: HeadSync, localHead: string): string {
  return sync === "inherited"
    ? ` — local HEAD ${localHead} carries work a killed pass left unpushed or uncommitted; this round settles it`
    : "";
}
