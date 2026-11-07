/** Probe another tree without conflating confirmed absence with failed inspection. */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { errnoCode, swallow } from "../../../../shared/errors.ts";
import {
  parseGitWorktreeList,
  samePath,
} from "../../../../shared/orca-workspace/git.ts";
import type { DoctorLeftovers } from "./doctor.ts";
import { attachedTree } from "./driven-branch.ts";
import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  unconcludedGitOpMarker,
} from "./proc.ts";

async function worktreePresence(
  worktree: string,
  clone: string,
  timeoutSec: number,
): Promise<"present" | "missing" | "unreadable"> {
  try {
    if (!statSync(worktree).isDirectory()) return "unreadable";
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "missing";
    swallow(error, "worktree presence could not be read");
    return "unreadable";
  }
  const listed = await git(["worktree", "list", "--porcelain", "-z"], {
    cwd: clone,
    env: gitIdentityEnv(),
    timeoutSec,
    stderr: "pipe",
  });
  if (listed.code !== 0) {
    swallow(listed, "worktree registry could not be read");
    return "unreadable";
  }
  if (
    !listed.stdout.endsWith("\0\0") ||
    !listed.stdout
      .split("\0\0")
      .slice(0, -1)
      .every((record) =>
        /^worktree [^\0]+\0(?:HEAD [a-f0-9]{40,64}\0|bare\0)/.test(
          `${record}\0`,
        ),
      )
  ) {
    swallow(
      new Error("malformed worktree registry response"),
      "worktree registration could not be inspected",
    );
    return "unreadable";
  }
  const rows = parseGitWorktreeList(listed.stdout);
  if (rows.length === 0 || rows.some((row) => !isAbsolute(row.path))) {
    swallow(
      new Error("worktree registry has no usable absolute paths"),
      "worktree registration could not be inspected",
    );
    return "unreadable";
  }
  return rows.some((row) => samePath(resolve(row.path), resolve(worktree)))
    ? "present"
    : "unreadable";
}

export async function gatherWorktreeLeftovers(
  worktree: string,
  clone: string = worktree,
): Promise<DoctorLeftovers | "missing" | null> {
  const timeoutSec = gitCallTimeoutSeconds();
  const presence = await worktreePresence(worktree, clone, timeoutSec);
  if (presence !== "present") return presence === "missing" ? "missing" : null;
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
  if (dirty.code !== 0) {
    swallow(dirty, "worktree status could not be inspected");
    return null;
  }
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
    {
      stderr: "pipe",
      timeoutSec,
      cwd: worktree,
      env,
    },
  );
  if (unpushedCount.code !== 0) {
    swallow(unpushedCount, "worktree unpushed commits could not be inspected");
    return null;
  }
  const n = Number.parseInt(unpushedCount.stdout.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return {
    uncommitted: dirty.stdout !== "",
    unpushed: n > 0,
    unconcludedOp: op.marker,
  };
}
