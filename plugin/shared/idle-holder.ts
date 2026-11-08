/**
 * Whether a worktree that has a branch checked out is idle, so that another
 * checkout may take the branch from it by detaching it at the same commit.
 *
 * Git lets one branch be checked out in only one worktree. When the tree that
 * holds it is a leftover (an agent's isolation worktree from the session that
 * built the pull request, say), opening the branch somewhere else waits on
 * that tree forever. Detaching an idle holder loses nothing: its commit stays
 * where it is, and the branch it gives up is on the remote. A holder is idle
 * only when every one of these holds, each read again on every call:
 *
 * | Check | Busy when |
 * | --- | --- |
 * | the checkout | it no longer has the branch checked out |
 * | `git status` | it reports a change, an untracked file or a submodule change |
 * | the index flags | an assume-unchanged or skip-worktree flag hides a change from `git status` |
 * | the git directory | a merge, cherry-pick, revert, bisect, rebase or sequencer is unfinished |
 * | the remote | `HEAD` has a commit `<remote>/<branch>` lacks, or, with no such branch, one no `<remote>` branch has |
 * | drives and sessions | the caller's `drivers` reader names a live driver or session lease on the tree |
 * | processes | a process of this user has its working directory in the tree |
 *
 * Every probe fails closed: one that cannot answer is a reason the holder is
 * busy, never a pass. The process probe reads `/proc` where the host has it,
 * else `lsof`, through the caller's runner, so it looks at the machine the
 * clone is on; it sees this user's processes only, as either tool can, and
 * a process whose working directory the kernel does not show even to its
 * owner (a service manager, say) is not counted. A host with neither
 * answers nothing, and so never has an idle holder.
 *
 * Whoever detaches a holder runs the check again immediately before it, and
 * detaches only at the commit the check read, so a tree that became busy in
 * between is left alone.
 */
import {
  budget,
  type Context,
  output,
  type RunResult,
} from "./orca-workspace/runner.ts";

/** The files and directories in a worktree's git directory that mean an operation is unfinished. */
export const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

/** `git status` arguments that report every change a tree holds: untracked files and submodules included, NUL-separated. */
export const CHANGES_STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
  "--ignore-submodules=none",
  "-z",
] as const;

/** Whether `git ls-files -v -z` output carries an assume-unchanged (lowercase tag) or skip-worktree (`S`) flag, which hides a change from `git status`. */
export function hidesIndexChanges(lsFiles: string): boolean {
  return lsFiles.split("\0").some((entry) => /^[a-zS] /.test(entry));
}

/** The tree a `drivers` reader is asked about: its top directory and the clone's git common directory, both absolute. */
export interface HeldTree {
  path: string;
  commonDir: string;
}

/**
 * What keeps a tree driven: one reason per live driver or session lease on
 * it, `[]` when there is none, `null` when that cannot be read.
 */
export type TreeDrivers = (tree: HeldTree) => string[] | null;

export interface HolderCheck {
  /** The holding worktree. */
  path: string;
  /** The branch it is expected to hold, without `refs/heads/`. */
  branch: string;
  /** The remote whose copy of the branch its commits must be on. */
  remote: string;
  drivers: TreeDrivers;
}

export type HolderVerdict =
  /** Nothing keeps the tree busy; `head` is the commit it is at. */
  | { idle: true; head: string }
  /** What keeps it busy, one clause each. */
  | { idle: false; reasons: string[] };

/** The deadline of one probe. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Lists this user's processes and their working directories: `/proc/<pid>\t<cwd>`
 * lines from `/proc` where the host has it, else `lsof`'s `p<pid>`/`n<cwd>`
 * fields.
 */
const CWD_PROBE = `if [ -e /proc/self/cwd ]; then exec find /proc -mindepth 2 -maxdepth 2 -name cwd -uid "$(id -u)" -printf '%h\\t%l\\n' 2>/dev/null; else exec lsof -a -d cwd -Fpn 2>/dev/null; fi`;

/** The pids whose working directory is `top` or under it, from either form `CWD_PROBE` prints. */
export function parseCwdHolders(listing: string, top: string): string[] {
  const pids: string[] = [];
  let pid: string | null = null;
  const inside = (cwd: string): boolean =>
    cwd === top || cwd.startsWith(top.endsWith("/") ? top : `${top}/`);
  for (const line of listing.split("\n")) {
    const proc = /^\/proc\/(\d+)\t(.*)$/.exec(line);
    if (proc !== null) {
      if (inside(proc[2] as string)) pids.push(proc[1] as string);
      continue;
    }
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid !== null && inside(line.slice(1)))
      pids.push(pid);
  }
  return [...new Set(pids)];
}

/**
 * The pids of this user's processes working in `top`; `null` when the host
 * cannot say. An empty listing is no answer, since it always holds the
 * probe's own process.
 */
function cwdHolders(ctx: Context, top: string): string[] | null {
  const listed = ctx.run(["sh", "-c", CWD_PROBE], {
    cwd: "/",
    timeoutMs: budget(ctx, PROBE_TIMEOUT_MS),
  });
  // `find` and `lsof` exit 1 when a process ended or hid while they read it.
  if ((listed.status !== 0 && listed.status !== 1) || listed.stdout === "")
    return null;
  return parseCwdHolders(listed.stdout, top);
}

/** Commits on `HEAD` the remote's copy of the branch lacks, or a reason it cannot be told. */
function unpushed(
  git: (args: string[]) => RunResult,
  remote: string,
  branch: string,
): string | null {
  const ref = `refs/remotes/${remote}/${branch}`;
  const exists = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (exists.status !== 0 && exists.status !== 1)
    return `whether ${remote}/${branch} exists cannot be read: ${output(exists)}`;
  const onRemote = exists.status === 0;
  const counted = git(
    onRemote
      ? ["rev-list", "--count", "HEAD", "--not", ref]
      : ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`],
  );
  const count = Number(counted.stdout.trim());
  if (counted.status !== 0 || !Number.isSafeInteger(count))
    return `its commits cannot be compared with ${remote}: ${output(counted)}`;
  if (count === 0) return null;
  return onRemote
    ? `${count} commit(s) not on ${remote}/${branch}`
    : `${count} commit(s) on no ${remote} branch, and ${remote} has no ${branch}`;
}

/** Which operation markers the git directory `admin` holds, or a reason they cannot be read. */
function unfinished(ctx: Context, admin: string): string | null {
  const listed = ctx.run(["ls", "-a", admin], {
    timeoutMs: budget(ctx, PROBE_TIMEOUT_MS),
  });
  if (listed.status !== 0)
    return `its git directory ${admin} cannot be listed: ${output(listed)}`;
  const names = new Set(listed.stdout.split("\n"));
  const found = GIT_OPERATION_MARKERS.filter((name) => names.has(name));
  return found.length === 0
    ? null
    : `an unfinished git operation (${found.join(", ")})`;
}

type Git = (args: string[]) => RunResult;

/** Where the worktree is: its top, git directory, the clone's common directory and its commit; `null` when git cannot read it. */
function locate(
  git: Git,
): { top: string; admin: string; commonDir: string; head: string } | null {
  const located = git([
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--path-format=absolute",
    "--git-common-dir",
    "HEAD",
  ]);
  const [top, admin, commonDir, head] = located.stdout.trim().split("\n");
  if (located.status !== 0 || !top || !admin || !commonDir || !head)
    return null;
  return /^[0-9a-f]{40,64}$/.test(head)
    ? { top, admin, commonDir, head }
    : null;
}

/** Why the branch checked out there is not `branch`, or `null`. */
function otherBranch(git: Git, branch: string): string | null {
  const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const name = current.stdout.trim();
  return current.status === 0 && name === branch
    ? null
    : `it has ${name || "no branch"} checked out now, not ${branch}`;
}

/** Why git reports changes there, or `null`. */
function changes(git: Git): string | null {
  const status = git([...CHANGES_STATUS_ARGS]);
  if (status.status !== 0)
    return `git status cannot read it: ${output(status)}`;
  return status.stdout === ""
    ? null
    : "it has uncommitted or untracked changes";
}

/** Why index flags may hide a change, or `null`. */
function hiddenChanges(git: Git): string | null {
  const flags = git(["ls-files", "-v", "-z"]);
  if (flags.status !== 0)
    return `its index flags cannot be read: ${output(flags)}`;
  return hidesIndexChanges(flags.stdout)
    ? "assume-unchanged or skip-worktree flags hide possible changes from git status"
    : null;
}

/** The drives and sessions on the tree, as reasons. */
function driven(drivers: TreeDrivers, tree: HeldTree): string[] {
  const found = drivers(tree);
  return found ?? ["whether a drive or session holds it cannot be read"];
}

/** The processes working in `top`, as reasons. */
function working(ctx: Context, top: string): string[] {
  const pids = cwdHolders(ctx, top);
  if (pids === null)
    return ["whether a process works in it cannot be told on this host"];
  if (pids.length === 0) return [];
  return pids.length === 1
    ? [`process ${pids[0]} has its working directory in it`]
    : [`processes ${pids.join(", ")} have their working directory in it`];
}

/**
 * Whether the worktree at `check.path` is idle and may be detached from
 * `check.branch`; what keeps it busy when it is not. Read-only: it fetches
 * nothing, so the caller refreshes `<remote>/<branch>` first when a stale
 * copy would matter (a stale one can only make the holder look busy).
 */
export function holderVerdict(ctx: Context, check: HolderCheck): HolderVerdict {
  const git: Git = (args) =>
    ctx.run(["git", "-c", "core.fsmonitor=false", "-C", check.path, ...args], {
      timeoutMs: budget(ctx, PROBE_TIMEOUT_MS),
    });
  const tree = locate(git);
  if (tree === null)
    return { idle: false, reasons: ["git cannot read the worktree"] };
  const reasons = [
    otherBranch(git, check.branch),
    changes(git),
    hiddenChanges(git),
    unfinished(ctx, tree.admin),
    unpushed(git, check.remote, check.branch),
  ].filter((reason): reason is string => reason !== null);
  reasons.push(
    ...driven(check.drivers, { path: tree.top, commonDir: tree.commonDir }),
    ...working(ctx, tree.top),
  );
  return reasons.length === 0
    ? { idle: true, head: tree.head }
    : { idle: false, reasons };
}
