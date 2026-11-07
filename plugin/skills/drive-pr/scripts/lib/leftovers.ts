/**
 * What a driven worktree still holds, and whether it still exists: the two
 * reads `drives.ts --doctor` and `drive.ts --take-over` make of a dead
 * driver's tree. A tree that holds uncommitted changes, unpushed commits or
 * an unconcluded git operation is a person's to push or discard; a tree that
 * no longer exists has no working files to inspect. Its commits may still be
 * recoverable from the clone's shared Git storage.
 */
import { statSync } from "node:fs";
import { errnoCode } from "../../../../shared/errors.ts";
import type { DoctorLeftovers } from "./doctor.ts";
import { attachedTree } from "./driven-branch.ts";
import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  unconcludedGitOpMarker,
} from "./proc.ts";

/**
 * What a driven worktree still holds, for `classifyDrive`'s
 * `DEAD_WITH_LEFTOVERS` check. `null` on ANY probe failure — including a
 * resolvable-but-empty upstream — rather than reporting a partial answer:
 * `DoctorLeftovers` has no per-field "unknown", so a probe this function cannot
 * complete must fail the WHOLE record rather than guess a boolean for the field
 * it could not determine. A tree that no longer exists is `null` too; whether
 * it vanished is `worktreeVanished`'s question.
 *
 * Three SEPARATE probes, deliberately not folded into `drive.ts`'s own
 * `leftoverReport`: that function has no notion of "unpushed" at all (a
 * stalled pass's own worktree is presumed pushed already, since a converged
 * drive certifies that before it ever returns), and it targets the CURRENT
 * process's cwd — this one targets an ARBITRARY other worktree by path.
 */
export async function gatherWorktreeLeftovers(
  worktree: string,
): Promise<DoctorLeftovers | null> {
  const timeoutSec = gitCallTimeoutSeconds();
  // `env: gitIdentityEnv()` on EVERY probe below, not just `cwd`: a hook
  // exports `GIT_DIR`/`GIT_WORK_TREE` into an operator's shell, and with a
  // leaked `GIT_DIR` git resolves refs from another repository, so `--doctor`
  // would report a stranger's unpushed commits as this drive's leftovers.
  const env = gitIdentityEnv();
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { stderr: "pipe", timeoutSec, cwd: worktree, env },
  );
  if (dirty.code !== 0) return null;
  const op = await unconcludedGitOpMarker(timeoutSec, { cwd: worktree, env });
  if (!op.ok) return null;
  // A missing upstream is a question this probe cannot answer, not a count:
  // checked structurally before `rev-list` counts against it. A detached
  // tree an attach prepared counts against its driven branch's remote ref.
  let upstreamRef = "@{u}";
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { stderr: "pipe", timeoutSec, cwd: worktree, env },
  );
  if (upstream.code !== 0) {
    const record = await attachedTree(git, worktree, { timeoutSec, env });
    if (record === null) return null;
    upstreamRef = `refs/remotes/${record.remote}/${record.branch}`;
  }
  const unpushedCount = await git(
    ["rev-list", "--count", `${upstreamRef}..HEAD`],
    { stderr: "pipe", timeoutSec, cwd: worktree, env },
  );
  if (unpushedCount.code !== 0) return null;
  const n = Number.parseInt(unpushedCount.stdout.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return {
    uncommitted: dirty.stdout !== "",
    unpushed: n > 0,
    unconcludedOp: op.marker,
  };
}

/** Whether `path` names a directory now: `absent` when nothing is there to read. */
function treeAt(path: string): "directory" | "absent" | "unreadable" {
  try {
    return statSync(path).isDirectory() ? "directory" : "absent";
  } catch (error) {
    const code = errnoCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

/**
 * Only positive directory absence admits a vanished tree. Missing Git
 * registration does not prove that existing working files are safe to abandon.
 * An unreadable path stays a person's to check.
 */
export async function worktreeVanished(worktree: string): Promise<boolean> {
  return treeAt(worktree) === "absent";
}
