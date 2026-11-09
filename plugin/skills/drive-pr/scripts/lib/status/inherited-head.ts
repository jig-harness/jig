/**
 * The one local head the head-sync guard accepts while it differs from the
 * API head: a head a pass left with unpushed commits (killed at its deadline,
 * or ended without pushing), or one the drive was armed over, which the
 * driver measured and names to the next gate (`--inherited-head`). Without
 * it, that gate reads the unpushed commits as replication lag and waits out
 * its timeout, and the pass that would push them never runs. A head that was
 * pushed and that the API has not caught up with is still polled as lag: the
 * driver names it only over uncommitted edits, and the guard refuses a named
 * head the PR's head branch already carries on the drive's remote ref, or
 * whose pushed state it cannot read.
 */
import { consumerRoot, remoteName } from "../../../../../shared/consumer.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { fail } from "../cli.ts";
import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  type RunResult,
} from "../proc.ts";

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
 * a lag behind a push or another branch. A head the PR's head branch
 * (`headBranch`) already carries on the drive's remote ref was pushed, so the
 * difference is lag after all. Any other mismatch, or a probe that cannot
 * answer (no head branch named included), is `false`, and the guard reports
 * `HEAD_LAG` as before. Measured in the driven tree (`$DRIVE_PR_WORKTREE`)
 * when one is named, as the local head itself is.
 */
export async function acceptsInheritedHead(
  apiHead: string,
  localHead: string,
  inheritedHead: string,
  headBranch = "",
): Promise<boolean> {
  if (inheritedHead === "" || localHead !== inheritedHead) return false;
  if (apiHead === "" || apiHead === localHead) return false;
  if (!(await isAncestor(apiHead, localHead))) return false;
  return (await pushedTo(localHead, headBranch)) === false;
}

function treeOpts() {
  const anchor = process.env.DRIVE_PR_WORKTREE;
  return {
    stderr: "pipe" as const,
    env: gitIdentityEnv(),
    timeoutSec: gitCallTimeoutSeconds(),
    ...(anchor ? { cwd: anchor } : {}),
  };
}

/** Whether `older` is an ancestor of `newer` in the driven tree; `false` when the probe cannot answer. */
async function isAncestor(older: string, newer: string): Promise<boolean> {
  if (older === "" || newer === "") return false;
  const res = await git(
    ["merge-base", "--is-ancestor", older, newer],
    treeOpts(),
  );
  return res.code === 0;
}

/**
 * Whether the drive's remote ref of the PR's head branch
 * (`refs/remotes/<remote>/<headBranch>`, the remote `repository.remote`, else
 * `origin`) contains `sha`: the drive pushes only to that remote, and the push
 * updates the ref. Another remote's ref of the same name says nothing about
 * the PR. `false` when the ref is confirmed absent (nothing was pushed);
 * `null` when no branch is named, the remote setting cannot be read or a
 * probe cannot answer.
 */
async function pushedTo(
  sha: string,
  headBranch: string,
): Promise<boolean | null> {
  if (headBranch === "") return null;
  const remote = driveRemoteName();
  if (remote === null) return null;
  const ref = `refs/remotes/${remote}/${headBranch}`;
  const exists = await git(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    treeOpts(),
  );
  noteProbeFailure("head mismatch remote-ref", exists);
  if (exists.code === 1) return false;
  if (exists.code !== 0) return null;
  // Exit 1 is git's "not an ancestor"; anything else is a probe that failed.
  const contains = await git(
    ["merge-base", "--is-ancestor", sha, ref],
    treeOpts(),
  );
  noteProbeFailure("head mismatch remote ancestry", contains);
  return contains.code === 0 ? true : contains.code === 1 ? false : null;
}

/** Exit 1 is a normal negative; preserve the cause of an unreadable probe. */
function noteProbeFailure(label: string, result: RunResult): void {
  if (result.code === 0 || result.code === 1) return;
  console.error(
    `${label} probe failed (exit ${result.code}, timedOut=${result.timedOut}): ${result.stderrTail.slice(-1200)}`,
  );
}

/** Explain a mismatch from ancestry and the drive's remote push witness. */
export async function headMismatchReason(
  apiHead: string,
  localHead: string,
  headBranch: string,
): Promise<string> {
  const prefix = `API head ${apiHead} != local HEAD ${localHead} — `;
  const ahead = await git(
    ["merge-base", "--is-ancestor", apiHead, localHead],
    treeOpts(),
  );
  noteProbeFailure("head mismatch ancestry", ahead);
  if (ahead.code === 0) {
    const pushed = await pushedTo(localHead, headBranch);
    if (pushed === false)
      return (
        prefix +
        "local HEAD is ahead and has no push witness on the drive remote; run guarded-push.ts to publish it"
      );
    if (pushed === true)
      return `${prefix}the API has not caught up with the push yet`;
    return (
      prefix +
      "local HEAD is ahead, but its pushed state could not be read; verify the remote before pushing or waiting"
    );
  }
  const behind = await git(
    ["merge-base", "--is-ancestor", localHead, apiHead],
    treeOpts(),
  );
  noteProbeFailure("head mismatch reverse ancestry", behind);
  if (behind.code === 0)
    return `${prefix}local HEAD is behind the API head; update the driven tree`;
  return (
    prefix +
    (ahead.code === 1 && behind.code === 1
      ? "the histories have diverged; inspect both heads before reconciling them"
      : "ancestry could not be read; inspect both heads before retrying")
  );
}

/** The drive's remote for the driven tree; `null` when its setting cannot be used. */
function driveRemoteName(): string | null {
  const anchor = process.env.DRIVE_PR_WORKTREE;
  try {
    return remoteName(consumerRoot(anchor || undefined));
  } catch (err) {
    swallow(err, "the drive's remote could not be read");
    return null;
  }
}

/** What the head-sync guard reads: in step, an accepted inherited head, or lag. */
export type HeadSync = "in-sync" | "inherited" | "lagging";

/** The head-sync guard's reading of the local head against the API head. */
export async function headSyncState(
  headSync: boolean,
  apiHead: string,
  localHead: string,
  inheritedHead: string,
  headBranch = "",
): Promise<HeadSync> {
  // On the PR head itself, a killed pass left uncommitted edits only: the
  // round that settles them is still owed, whether or not the local head is
  // compared at all (`--no-head-sync` leaves it unread).
  const local = localHead === "" ? apiHead : localHead;
  if (inheritedHead !== "" && apiHead === inheritedHead && local === apiHead)
    return "inherited";
  // With the local head unread, the witnessed head decides: the round is
  // still owed until GitHub's head contains it, and a probe that cannot
  // tell owes it too.
  if (!headSync && inheritedHead !== "" && inheritedHead !== apiHead)
    return (await isAncestor(inheritedHead, apiHead)) ? "in-sync" : "inherited";
  if (!headSync || apiHead === localHead) return "in-sync";
  return (await acceptsInheritedHead(
    apiHead,
    localHead,
    inheritedHead,
    headBranch,
  ))
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

/**
 * What a ready round's reason adds when it pushes an inherited head, named
 * by the witnessed head when the local head was not read.
 */
export function inheritedReason(
  sync: HeadSync,
  localHead: string,
  inheritedHead = "",
): string {
  return sync === "inherited"
    ? ` — local HEAD ${localHead || inheritedHead} carries work a pass left unpushed or uncommitted; this round settles it`
    : "";
}
