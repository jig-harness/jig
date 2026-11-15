/**
 * Holding an agent tool worktree's HEAD from the final identity comparison
 * through its removal. Git offers no atomic check-and-remove, and a commit on
 * a detached head is on no ref: one made after the comparison would go with
 * the tree's HEAD and its log. Git takes `HEAD.lock` in the worktree's git
 * directory, with an exclusive create, before it moves HEAD, so while gc
 * holds that file a commit, checkout, switch or reset in the tree fails with
 * git's own "cannot lock ref" error instead of moving the head. `git worktree
 * remove` deletes the git directory, the lock with it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
 * Null when the tree's head can be held, or the reason it is kept: a detached
 * tree in a repository that keeps its refs in a store other than files, where
 * `HEAD.lock` holds nothing. A tree on a branch is collected there without a
 * hold, as its branch keeps a commit made on it. Read before the remove hook,
 * so a tree that would be kept anyway is not torn down on every run.
 */
export async function headHoldRefusal(
  path: string,
  identity: WorktreeIdentity,
): Promise<Outcome<string | null, "git-failed">> {
  const store = await refStore(path);
  return store.ok ? ok(refusalUnder(store.value, identity)) : store;
}
function refusalUnder(
  store: string,
  identity: WorktreeIdentity,
): string | null {
  return store === "files" || identity.name !== "HEAD"
    ? null
    : `kept: a detached head cannot be held through removal under git's ${store} ref store`;
}

/**
 * Hold the worktree's HEAD. Fails, and the tree is kept, when git already
 * holds it, when the tree's git directory is no longer the one the proof
 * read, when the lock cannot be written, or as `headHoldRefusal` says. The
 * lock names `jig gc` and its process, for a person who finds one a stopped
 * run left behind.
 */
export async function holdHead(
  path: string,
  identity: WorktreeIdentity,
): Promise<Outcome<HeadHold, "head-unheld" | "git-failed">> {
  const store = await refStore(path);
  if (!store.ok) return store;
  const refusal = refusalUnder(store.value, identity);
  if (refusal !== null) return failed("head-unheld", refusal);
  if (store.value !== "files") return ok(NOTHING_HELD);
  const dir = await git(path, ["rev-parse", "--git-dir"]);
  if (!dir.ok) return dir;
  const admin = isAbsolute(dir.value) ? dir.value : resolve(path, dir.value);
  if (admin !== identity.admin)
    return failed(
      "head-unheld",
      "kept: the worktree's git directory changed after the proof",
    );
  const lock = join(admin, "HEAD.lock");
  const token = `jig gc ${process.pid} ${randomUUID()}\n`;
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
          `gc could not release ${lock}, which keeps git from moving the tree's HEAD; remove it by hand: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },
  });
}

/** The repository's ref store, `files` unless `extensions.refStorage` names another. */
async function refStore(path: string): Promise<Outcome<string, "git-failed">> {
  const store = await git(path, [
    "config",
    "--default",
    "files",
    "--get",
    "extensions.refStorage",
  ]);
  return store.ok ? ok(store.value.toLowerCase()) : store;
}
