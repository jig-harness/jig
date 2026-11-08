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
 * The holder must be a linked worktree: the clone's main checkout is never
 * idle here, since detaching it would leave the clone itself without its
 * branch.
 *
 * Every probe fails closed: one that cannot answer is a reason the holder is
 * busy, never a pass. A probe cut short by the caller's time limit is
 * marked (`timedOut`), so the caller can tell its own clock from a busy
 * tree. The process probe reads `/proc` where the host has it, else `lsof`,
 * through the caller's runner, so it looks at the machine the clone is on
 * (`process-cwd.ts` says which errors it accepts).
 *
 * What it cannot see:
 *
 * - A session whose own process works elsewhere and runs its commands in
 *   the tree from short-lived shells, as an agent does: between commands no
 *   process is in the tree. Its leases, and the clean and pushed checks,
 *   still apply.
 * - Another user's processes, and processes in another mount namespace (a
 *   container), whose working directories it cannot read or compare.
 * - Anything on a host whose git is older than 2.31, which cannot print
 *   absolute paths as the check asks; there the tree reads as busy.
 *
 * Whoever detaches a holder does so right after the check, and only while
 * `HEAD` is still at the commit the check read (`git update-ref` with that
 * commit as the old value), so a tree that moved in between is left alone.
 */
import {
  budget,
  type Context,
  output,
  type RunResult,
} from "./orca-workspace/runner.ts";
import { cwdHolders, type ProbeRun } from "./process-cwd.ts";

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
 * it, `[]` when there is none, or why that cannot be read.
 */
export type TreeDrivers = (tree: HeldTree) => string[] | { unreadable: string };

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
  /**
   * What keeps it busy, one clause each. `timedOut` when a probe was cut
   * short by the time it was given: the reasons may then be the caller's
   * clock rather than the tree, and the check is worth running again.
   */
  | { idle: false; reasons: string[]; timedOut: boolean };

/** The deadline of one probe. */
const PROBE_TIMEOUT_MS = 30_000;

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
function unfinished(run: ProbeRun, admin: string): string | null {
  const listed = run(["ls", "-a", admin]);
  if (listed.status !== 0)
    return `its git directory ${admin} cannot be listed: ${output(listed)}`;
  const names = new Set(listed.stdout.split("\n"));
  const found = GIT_OPERATION_MARKERS.filter((name) => names.has(name));
  return found.length === 0
    ? null
    : `an unfinished git operation (${found.join(", ")})`;
}

type Git = (args: string[]) => RunResult;

/** Where the worktree is: its top, git directory, the clone's common directory and its commit. */
interface Located {
  top: string;
  admin: string;
  commonDir: string;
  head: string;
}

/** Where the worktree is, or why git cannot say. */
function locate(git: Git): Located | { unreadable: string } {
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
    return {
      unreadable: `git cannot read the worktree (exit ${located.status}): ${output(located) || "no output"}`,
    };
  return /^[0-9a-f]{40,64}$/.test(head)
    ? { top, admin, commonDir, head }
    : { unreadable: `git reads no commit at its HEAD: ${head}` };
}

/** Why the branch checked out there is not `branch`, or `null`. */
function otherBranch(git: Git, branch: string): string | null {
  const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const name = current.stdout.trim();
  if (current.status === 1)
    return `it has no branch checked out now, not ${branch}`;
  if (current.status !== 0)
    return `the checked-out branch cannot be read: ${output(current) || `exit ${current.status}`}`;
  return name === branch
    ? null
    : `it has ${name} checked out now, not ${branch}`;
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
  return Array.isArray(found)
    ? found
    : [
        `whether a drive or session holds it cannot be read: ${found.unreadable}`,
      ];
}

/** The processes working in `top`, as reasons. */
function working(run: ProbeRun, top: string): string[] {
  const answer = cwdHolders(run, top);
  if ("unknown" in answer)
    return [`whether a process works in it cannot be told: ${answer.unknown}`];
  const { pids } = answer;
  if (pids.length === 0) return [];
  return pids.length === 1
    ? [`process ${pids[0]} has its working directory in it`]
    : [`processes ${pids.join(", ")} have their working directory in it`];
}

/** One probe at a time on `ctx`, each held to the time left, noting whether one was cut short by it. */
function prober(ctx: Context): { run: ProbeRun; timedOut: () => boolean } {
  let cut = false;
  const run: ProbeRun = (argv, cwd) => {
    const timeoutMs = budget(ctx, PROBE_TIMEOUT_MS);
    const started = Date.now();
    const done = ctx.run(argv, {
      timeoutMs,
      ...(cwd === undefined ? {} : { cwd }),
    });
    // The runner reports a killed child as -1; one that ran its whole time was cut short.
    if (done.status === -1 && Date.now() - started >= timeoutMs) cut = true;
    return done;
  };
  return { run, timedOut: () => cut };
}

/** Why the tree, read by `git`, is busy; the reasons that need no git are added by the caller. */
function gitReasons(
  git: Git,
  run: ProbeRun,
  tree: Located,
  check: HolderCheck,
): string[] {
  return [
    tree.admin === tree.commonDir
      ? "it is the clone's main checkout, which is never detached"
      : null,
    otherBranch(git, check.branch),
    changes(git),
    hiddenChanges(git),
    unfinished(run, tree.admin),
    unpushed(git, check.remote, check.branch),
  ].filter((reason): reason is string => reason !== null);
}

/**
 * Whether the worktree at `check.path` is idle and may be detached from
 * `check.branch`; what keeps it busy when it is not. Read-only: it fetches
 * nothing, so the caller refreshes `<remote>/<branch>` first when a stale
 * copy would matter (a stale one can only make the holder look busy). Once
 * the caller's time limit has passed, the runner's error is thrown.
 */
export function holderVerdict(ctx: Context, check: HolderCheck): HolderVerdict {
  const { run, timedOut } = prober(ctx);
  const git: Git = (args) =>
    run(["git", "-c", "core.fsmonitor=false", "-C", check.path, ...args]);
  const tree = locate(git);
  if ("unreadable" in tree)
    return { idle: false, reasons: [tree.unreadable], timedOut: timedOut() };
  const reasons = [
    ...gitReasons(git, run, tree, check),
    ...driven(check.drivers, { path: tree.top, commonDir: tree.commonDir }),
    ...working(run, tree.top),
  ];
  return reasons.length === 0
    ? { idle: true, head: tree.head }
    : { idle: false, reasons, timedOut: timedOut() };
}
