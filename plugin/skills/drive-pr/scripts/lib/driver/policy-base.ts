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
 *
 * A stacked layer's base is the layer below, whose policy no one has
 * reviewed yet: the integration branch's commit goes out as
 * `$DRIVE_PR_POLICY_BOUND`, and the layer below can only narrow what that
 * policy allows. It is unset when the base is the integration branch. The
 * integration branch is never read from the checkout's own
 * `repository.base_branch`, which the pull request could set to its own base:
 * it is the `repository.base_branch` the repository's default branch commits
 * (reviewed policy), else that default branch itself.
 */
import {
  POLICY_BASE_VARIABLE,
  POLICY_BOUND_VARIABLE,
  readSnapshotAt,
} from "../../../../../shared/autonomy.ts";
import {
  consumerRoot,
  readRemoteName,
} from "../../../../../shared/consumer.ts";
import { baseBranch, freshPrBaseRef } from "../overlay.ts";
import { isMapping } from "../../../../../shared/config-layers.ts";
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
  const bound =
    "error" in base || "error" in resolved
      ? null
      : await integrationBound(root, base.ref);
  const result = bound !== null && "error" in bound ? bound : resolved;
  const failed = "error" in result;
  process.env[POLICY_BASE_VARIABLE] = failed ? "" : result.commit;
  if (!failed && bound !== null && "commit" in bound)
    process.env[POLICY_BOUND_VARIABLE] = bound.commit;
  else delete process.env[POLICY_BOUND_VARIABLE];
  return result;
}

/**
 * The integration branch's current commit when `baseRef` is another branch
 * (a stacked layer's base), `null` when the base is the integration branch,
 * or the reason it cannot be resolved.
 */
async function integrationBound(
  root: string,
  baseRef: string,
): Promise<{ commit: string } | { error: string } | null> {
  const remote = readRemoteName(root);
  if ("error" in remote) return remote;
  const defaultBranch = await baseBranch(root, gitCallTimeoutSeconds(), true);
  if (defaultBranch === null)
    return {
      error:
        "the integration branch is unknown, so a stacked base's policy cannot be bounded by it",
    };
  const declared = await declaredIntegrationBranch(
    root,
    remote.remote,
    defaultBranch,
  );
  if (declared !== null && "error" in declared) return declared;
  const branch = declared?.branch ?? defaultBranch;
  const ref = `refs/remotes/${remote.remote}/${branch}`;
  if (ref === baseRef) return null;
  const fetched = await refreshTrackingRef(root, ref);
  return fetched !== null ? fetched : commitOf(root, ref);
}

/**
 * The `repository.base_branch` the default branch's own commit declares, or
 * `null` when it declares none (or `DRIVE_PR_BASE_BRANCH`, the driver's own
 * environment, already named the branch). The default branch is the one
 * place a reviewed change to the setting lands, so a configuration that
 * names an integration branch other than the remote's default is honoured
 * without trusting the pull request's checkout.
 */
async function declaredIntegrationBranch(
  root: string,
  remote: string,
  defaultBranch: string,
): Promise<{ branch: string } | { error: string } | null> {
  if ((process.env.DRIVE_PR_BASE_BRANCH ?? "").trim() !== "") return null;
  const ref = `refs/remotes/${remote}/${defaultBranch}`;
  const fetched = await refreshTrackingRef(root, ref);
  if (fetched !== null) return fetched;
  const at = await commitOf(root, ref);
  if ("error" in at) return at;
  const snapshot = readSnapshotAt(
    at.commit,
    POLICY_BASE_VARIABLE,
    "default",
    process.env,
    root,
  );
  if (snapshot.from !== "base")
    return {
      error:
        snapshot.from === "unreadable"
          ? snapshot.reason
          : "the default branch's configuration cannot be read",
    };
  const repo = snapshot.values.repository;
  const name = isMapping(repo) ? repo.base_branch : undefined;
  if (name === undefined || name === null) return null;
  return typeof name === "string" && /^[^\s~^:?*[\\]+$/.test(name)
    ? { branch: name }
    : { error: `repository.base_branch at ${ref} is not a branch name` };
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
