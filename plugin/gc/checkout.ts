import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { gcGit as git } from "./git.ts";

/**
 * `root` lies inside a clone but is none of its checkouts: Git discovers the
 * enclosing clone from any directory beneath a checkout, and that clone is
 * not the one the path names.
 */
export class NotACheckoutError extends Error {}
/**
 * The clone's worktrees, as `git worktree list` names them, primary first.
 * Read NUL-delimited, since a path may hold any character but NUL. A bare
 * clone has no primary checkout: `primary` is then null. A `root` that is
 * neither a worktree nor the bare clone throws `NotACheckoutError`.
 */
export async function cloneCheckouts(
  root: string,
): Promise<{ primary: string | null; worktrees: string[] }> {
  const blocks = (await git(root, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0\0")
    .filter(Boolean)
    .map((block) => block.split("\0"));
  const path = (fields: string[]) => {
    const field = fields.find((entry) => entry.startsWith("worktree "));
    return field === undefined
      ? undefined
      : resolve(field.slice("worktree ".length));
  };
  const own = canonicalPath(root);
  const named = (fields: string[]) => {
    const entry = path(fields);
    return entry !== undefined && canonicalPath(entry) === own;
  };
  if (!blocks.some(named))
    throw new NotACheckoutError(
      `${root} lies inside a clone but is none of its checkouts`,
    );
  const first = blocks[0];
  const primary =
    first === undefined || first.includes("bare") ? undefined : path(first);
  return {
    primary: primary ?? null,
    worktrees: blocks
      .filter((fields) => !fields.includes("bare"))
      .map(path)
      .filter((entry): entry is string => entry !== undefined),
  };
}
/**
 * The clone's primary checkout, which a machine entry names whichever of the
 * clone's worktrees `root` is. A bare clone has none and keeps `root`, as
 * does a `root` that already is the primary, in the caller's spelling.
 */
export function primaryCheckout(
  root: string,
  { primary }: { primary: string | null },
): string {
  if (primary === null) return root;
  return canonicalPath(primary) === canonicalPath(root) ? root : primary;
}
/**
 * The spelling-independent identity of a checkout path: symbolic links
 * resolved, so `/alias/repo` and `/physical/repo` compare equal. A path that
 * no longer exists keeps its lexical form, so an entry naming a deleted
 * checkout still matches its own spelling.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
