/**
 * The base-branch commit a drive's autonomy policy is read from.
 *
 * `autonomy.max_level` and `autonomy.park_classes` bound what every agent in
 * the repository may decide, so a drive reads them from the pull request's
 * base branch rather than its own checkout (`shared/autonomy.ts`). The
 * driver resolves that commit and exports it as `$DRIVE_PR_POLICY_BASE`, to
 * its own reads and, through the inherited environment, to every pass. It
 * resolves it at startup and again before every round, so a newer base
 * commit, or a pull request retargeted at another base, applies to the next
 * round. The variable is always overwritten: a value inherited from whatever
 * launched the driver never stands. When the base cannot be resolved it is
 * left empty, which the reader treats as an unreadable policy and fails
 * closed.
 */
import { POLICY_BASE_VARIABLE } from "../../../../../shared/autonomy.ts";
import {
  consumerRoot,
  readRemoteName,
} from "../../../../../shared/consumer.ts";
import { freshPrBaseRef } from "../overlay.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "../proc.ts";

/** The commit `ref` names in `root`, or the reason it names none. */
async function commitOf(
  root: string,
  ref: string,
): Promise<{ commit: string } | { error: string }> {
  const r = await git(
    ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    {
      stderr: "pipe",
      timeoutSec: gitCallTimeoutSeconds(),
      env: gitIdentityEnv(),
    },
  );
  const commit = r.stdout.trim();
  return r.code === 0 && commit !== ""
    ? { commit }
    : {
        error: `${ref} does not name a commit in this clone${r.stderrTail ? ` (${r.stderrTail.trim()})` : ""}`,
      };
}

/**
 * Bring the tracking ref `ref` (`refs/remotes/<remote>/<branch>`) up to the
 * remote's current tip, or say why it could not: a policy read off a stale
 * snapshot could still carry permission the base has since withdrawn.
 */
async function refreshTrackingRef(
  root: string,
  ref: string,
): Promise<{ error: string } | null> {
  const remote = readRemoteName(root);
  if ("error" in remote) return remote;
  const prefix = `refs/remotes/${remote.remote}/`;
  if (!ref.startsWith(prefix)) return { error: `${ref} is not a tracking ref` };
  const branch = ref.slice(prefix.length);
  const r = await git(
    [
      "-C",
      root,
      "fetch",
      "--quiet",
      remote.remote,
      `+refs/heads/${branch}:${ref}`,
    ],
    {
      stderr: "pipe",
      timeoutSec: gitCallTimeoutSeconds(),
      env: gitIdentityEnv(),
    },
  );
  return r.code === 0
    ? null
    : {
        error: `cannot fetch ${remote.remote}/${branch}, so its current commit is unknown${r.stderrTail ? ` (${r.stderrTail.trim()})` : ""}`,
      };
}

/**
 * Resolve pull request `pr`'s base-branch commit and export it as
 * `$DRIVE_PR_POLICY_BASE`; empty when it cannot be resolved. Returns the
 * commit, or the reason it could not be resolved, for the caller to print
 * beside the autonomy line.
 */
export async function exportPolicyBase(
  pr: string,
  root: string = consumerRoot(),
): Promise<{ commit: string } | { error: string }> {
  const base = await freshPrBaseRef(root, pr, gitCallTimeoutSeconds());
  const fetched =
    "error" in base ? null : await refreshTrackingRef(root, base.ref);
  const resolved =
    "error" in base
      ? base
      : fetched !== null
        ? fetched
        : await commitOf(root, base.ref);
  process.env[POLICY_BASE_VARIABLE] =
    "error" in resolved ? "" : resolved.commit;
  return resolved;
}

/** The line that says why the policy fails closed, or `null` when it reads. */
export function policyBaseNotice(
  resolved: { commit: string } | { error: string },
): string | null {
  return "error" in resolved
    ? `autonomy policy: ${resolved.error}; the policy fails closed (attended, every decision parked under human-decision) until the base branch reads`
    : null;
}

/** `exportPolicyBase`, printing why the policy fails closed when it does. */
export async function announcePolicyBase(pr: string): Promise<void> {
  const notice = policyBaseNotice(await exportPolicyBase(pr));
  if (notice !== null) console.error(notice);
}
