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

/** The git seam the callers already inject (`lib/base-drift.ts`'s shape). */
type Git = (
  args: string[],
  opts?: { timeoutSec?: number; env?: Record<string, string | undefined> },
) => Promise<{ code: number; stdout: string }>;

interface Opts {
  timeoutSec?: number;
  env?: Record<string, string | undefined>;
}

/** The attach record of the tree at `root`, when its head is detached. */
export function attachedTree(
  git: Git,
  root: string,
  opts: Opts = {},
): Promise<DrivenTree | null> {
  return detachedTreeRecord((args) =>
    git(["-C", root, ...args], {
      ...definedFields({ timeoutSec: opts.timeoutSec, env: opts.env }),
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
  drivenRemoteRef = `${remote}/${branch}`;
}

/**
 * The command that counts commits a stopped pass left unpushed: against the
 * driven branch's remote ref once the attach has named it, since a detached
 * tree has no `@{u}`. The range is shell-quoted: a branch name may carry `;`,
 * `$` or backticks, and the operator pastes this line into a shell.
 */
export function unpushedCountCommand(): string {
  return `git rev-list --count ${shellQuote(`${drivenRemoteRef ?? "@{u}"}..HEAD`)}`;
}
