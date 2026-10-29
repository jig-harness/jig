/**
 * The branch a working tree drives, read the same way at every site that
 * needs it.
 *
 * A tree on a branch drives that branch. A tree the attach left on a detached
 * head (`lib/attach.ts`: another working tree holds the head branch) drives
 * the branch its attach record names (`shared/driven-tree.ts`), and that is
 * the name every check comparing "the checked-out branch" with the pull
 * request's head reads. `HEAD` stays the answer for a detached tree no attach
 * prepared, so the refusals that name a detached head still fire for one.
 */
import {
  type DrivenTree,
  detachedTreeRecord,
} from "../../../../shared/driven-tree.ts";
import { shellQuote } from "../../../../shared/cli.ts";
import { definedFields } from "../../../../shared/defined-fields.ts";
import { gitIdentityEnv } from "../../../../shared/proc.ts";

/** The git seam the callers already inject (`lib/base-drift.ts`'s shape). */
type Git = (
  args: string[],
  opts?: { timeoutSec?: number; env?: Record<string, string | undefined> },
) => Promise<{ code: number; stdout: string }>;

interface Opts {
  timeoutSec?: number;
  env?: Record<string, string | undefined>;
}

/**
 * The attach record of the tree at `root`, when its head is detached. Git
 * runs without inherited location variables (`gitIdentityEnv`) unless the
 * caller passes an environment: an exported `GIT_DIR` overrides `-C root`,
 * and would read another tree's record.
 */
export function attachedTree(
  git: Git,
  root: string,
  opts: Opts = {},
): Promise<DrivenTree | null> {
  return detachedTreeRecord((args) =>
    git(["-C", root, ...args], {
      ...definedFields({ timeoutSec: opts.timeoutSec }),
      env: opts.env ?? gitIdentityEnv(),
    }),
  );
}

/**
 * The branch the tree at `root` drives: `git rev-parse --abbrev-ref HEAD`,
 * or, on a detached head, the branch its attach record names. `HEAD` for a
 * detached tree with no record; `null` when git cannot say.
 */
export async function drivenBranchName(
  git: Git,
  root: string,
  opts: Opts = {},
): Promise<string | null> {
  const res = await git(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
    ...definedFields({ timeoutSec: opts.timeoutSec, env: opts.env }),
  });
  if (res.code !== 0) return null;
  const name = res.stdout.trim();
  if (name !== "HEAD") return name;
  return (await attachedTree(git, root, opts))?.branch ?? "HEAD";
}

let drivenRemoteRef: string | null = null;

/** Recorded by the driver once its attach has named the head branch. */
export function setDrivenRemoteRef(remote: string, branch: string): void {
  // The full ref: `origin/topic` would resolve a local branch or tag of
  // that name before the remote-tracking branch.
  drivenRemoteRef = `refs/remotes/${remote}/${branch}`;
}

/** The revision range of the commits a stopped pass left unpushed. */
export function unpushedRange(): string {
  return `${drivenRemoteRef ?? "@{u}"}..HEAD`;
}

/**
 * The range the advice counts a stopped pass's unpushed commits over, or `null`
 * when none can be named. The driven branch's remote ref once the attach has
 * named it. Without that (`DRIVE_PR_ATTACH=off` runs no attach), the sources the
 * leftovers probe reads (`drives.ts`): the upstream when it exists, else the
 * attach record's remote ref when the tree is detached with one.
 */
async function unpushedAdviceRange(
  git: Git,
  root: string,
  opts: Opts,
): Promise<string | null> {
  if (drivenRemoteRef !== null) return `${drivenRemoteRef}..HEAD`;
  const upstream = await git(
    ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    {
      ...definedFields({ timeoutSec: opts.timeoutSec }),
      env: opts.env ?? gitIdentityEnv(),
    },
  );
  if (upstream.code === 0) return "@{u}..HEAD";
  const record = await attachedTree(git, root, opts);
  return record === null
    ? null
    : `refs/remotes/${record.remote}/${record.branch}..HEAD`;
}

/**
 * The advice for counting commits a stopped pass left unpushed, as the phrase
 * the report puts in its sentence: the count command over the range
 * `unpushedAdviceRange` names (a detached tree has no `@{u}`), else the check to
 * make by hand, since a range that does not exist fails or counts nothing.
 * That check names `HEAD` as well as `--branches`: a detached head's commits
 * are on no branch. The range is shell-quoted: a branch name may carry `;`, `$` or backticks,
 * and the operator pastes this line into a shell.
 */
export async function unpushedCountAdvice(
  git: Git,
  root: string,
  opts: Opts = {},
): Promise<string> {
  const range = await unpushedAdviceRange(git, root, opts);
  if (range !== null) return `\`git rev-list --count ${shellQuote(range)}\``;
  return "`git log HEAD --branches --not --remotes` (no range can be named here: the tree has no upstream and no attach record)";
}
