/**
 * Holding a detached agent tool worktree's HEAD from the final identity
 * comparison through its removal. Git offers no atomic check-and-remove, and
 * a commit on a detached head is on no ref: one made after the comparison
 * would go with the tree's HEAD and its log. Git takes `HEAD.lock` in the
 * worktree's git directory, with an exclusive create, before it moves HEAD,
 * so while gc holds that file a commit, checkout or reset in the tree fails
 * with git's own "cannot lock ref" error instead of moving the head. `git
 * worktree remove` deletes the git directory, the lock with it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { gcGit as git } from "../git.ts";
import type { WorktreeIdentity } from "./worktree-proof.ts";

/** A held head, released once the removal ran or was refused. */
export interface HeadHold {
  /** Delete the lock while it is still the one this hold wrote. */
  release(): Outcome<undefined, "release-failed">;
}

const NOTHING_HELD: HeadHold = { release: () => ok(undefined) };

/**
 * Hold the worktree's HEAD when it is detached; a branch keeps its own
 * commits, so a tree on one needs no hold. Fails, and the tree is kept, when
 * git already holds HEAD, when the repository keeps its refs in a store other
 * than files (where `HEAD.lock` holds nothing), or when the lock cannot be
 * written.
 */
export async function holdDetachedHead(
  path: string,
  identity: WorktreeIdentity,
): Promise<Outcome<HeadHold, "head-unheld" | "git-failed">> {
  if (identity.name !== "HEAD") return ok(NOTHING_HELD);
  const store = await git(path, [
    "config",
    "--default",
    "files",
    "--get",
    "extensions.refStorage",
  ]);
  if (!store.ok) return store;
  if (store.value.toLowerCase() !== "files")
    return failed(
      "head-unheld",
      `kept: a detached head cannot be held through removal under the ${store.value} ref store`,
    );
  const lock = join(identity.admin, "HEAD.lock");
  const token = randomUUID();
  try {
    writeFileSync(lock, token, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failed(
      "head-unheld",
      code === "EEXIST"
        ? "kept: a git process holds the worktree's HEAD (HEAD.lock exists)"
        : `kept: the worktree's HEAD cannot be held: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  return ok({
    release: () => {
      try {
        if (readFileSync(lock, "utf8") === token) rmSync(lock);
        return ok(undefined);
      } catch (error) {
        // Removed with the tree's git directory.
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return ok(undefined);
        return failed(
          "release-failed",
          `${lock} could not be released; remove it by hand: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },
  });
}
