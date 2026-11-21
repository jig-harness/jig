/**
 * Whether a worktree that has a branch checked out is idle, so that another
 * checkout may take the branch from it by detaching it at the same commit.
 *
 * Git lets one branch be checked out in only one worktree. When the tree that
 * holds it is a leftover (an agent's isolation worktree from the session that
 * built the pull request, say), opening the branch somewhere else waits on
 * that tree forever. Detaching an idle holder loses nothing: its commit stays
 * where it is, the branch it gives up keeps every commit, and their change
 * is on the remote. A holder is idle
 * only when every one of these holds, each read again on every call:
 *
 * | Check | Busy when |
 * | --- | --- |
 * | the checkout | it no longer has the branch checked out |
 * | `git status` | it reports a change, an untracked file or a submodule change |
 * | the index flags | an assume-unchanged or skip-worktree flag hides a change from `git status` |
 * | the git directory | a merge, cherry-pick, revert, bisect, rebase or sequencer is unfinished |
 * | the remote | `HEAD` has a commit `<remote>/<branch>` lacks, or, with no such branch, one no `<remote>` branch has whose change the remote's default branch lacks too: neither it nor a later commit has the tree of a commit there, its patch is not there, and merging `HEAD` into that branch would change it |
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
 * - A change the base branch holds only in another form: patch-id matching
 *   ignores whitespace, and an empty commit changes nothing, so either counts
 *   as merged. The branch keeps such a commit after the detach.
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
import { currentMs } from "./time.ts";

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

/** How many tips of the unmerged commits are tried as a merged prefix. */
const MERGE_PROBES = 12;

/** How many unmerged commits a busy reason names, newest first; the rest are counted. */
const NAMED_COMMITS = 5;

/** The remote's default branch, as the remote names it now, or a reason it cannot be read. */
function defaultBranch(
  git: (args: string[]) => RunResult,
  remote: string,
): { branch: string } | { unreadable: string } {
  const listed = git(["ls-remote", "--symref", remote, "HEAD"]);
  const named = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed.stdout);
  return listed.status === 0 && named?.[1] !== undefined
    ? { branch: named[1] }
    : {
        unreadable: `${remote}'s default branch cannot be read: ${output(listed) || `exit ${listed.status}`}`,
      };
}

/** Lines of a git answer, or why git gave none. */
function lines(answer: RunResult): string[] | { unreadable: string } {
  return answer.status === 0
    ? answer.stdout.split("\n").filter(Boolean)
    : { unreadable: output(answer) || `exit ${answer.status}` };
}

/** Most paths the merge's attribute check names; a change touching more reads as unprovable. */
const ATTRIBUTE_PATHS = 200;

/** Why a `merge` attribute may apply to a path `ref` and `tip` differ in, or why that cannot be read; `null` when none does. */
function mergeAttributes(
  git: (args: string[]) => RunResult,
  ref: string,
  tip: string,
  emptyTree: string,
): string | null {
  const differing = git(["diff", "--name-only", "-z", ref, tip]);
  if (differing.status !== 0)
    return `${ref} and ${tip} cannot be compared: ${output(differing) || `exit ${differing.status}`}`;
  const paths = differing.stdout.split("\0").filter(Boolean);
  if (paths.length > ATTRIBUTE_PATHS)
    return `${tip} differs from ${ref} in too many files`;
  if (paths.length === 0) return null;
  const checked = git([
    "--attr-source",
    emptyTree,
    "-c",
    "core.attributesFile=/dev/null",
    "check-attr",
    "merge",
    "--",
    ...paths,
  ]);
  if (checked.status !== 0)
    return `merge attributes cannot be read: ${output(checked) || `exit ${checked.status}`}`;
  const set = checked.stdout
    .split("\n")
    .some((line) => line !== "" && !line.endsWith(": unspecified"));
  return set ? "a merge attribute applies outside the tree" : null;
}

/**
 * Whether merging `tip` into `ref` changes nothing: the base branch already
 * holds that history's whole change, as after a squash merge of several
 * commits once the base had moved on. The merge ignores tracked attributes
 * files, the user's attributes file and the default merge driver
 * (`merge.default`), and is not trusted when the repository configures a
 * custom merge driver or any attribute source it cannot neutralize (the
 * clone's `info/attributes`, the system attributes) assigns a `merge`
 * attribute to a path the two sides differ in: a driver can resolve
 * conflicting edits to either side, and an unchanged result would then prove
 * nothing. `git merge-tree --write-tree` needs git 2.38 and `--attr-source`
 * git 2.41; an older git is reported, never read as merged. A merge that
 * conflicts answers no.
 */
function mergesToNothing(
  git: (args: string[]) => RunResult,
  ref: string,
  tip: string,
): boolean | { unreadable: string } {
  const drivers = git(["config", "--get-regexp", "^merge\\..*\\.driver$"]);
  if (drivers.status === 0)
    return { unreadable: "a custom merge driver is configured" };
  if (drivers.status !== 1)
    return {
      unreadable: `merge drivers cannot be read: ${output(drivers) || `exit ${drivers.status}`}`,
    };
  const empty = git(["hash-object", "-t", "tree", "/dev/null"]);
  const emptyTree = empty.stdout.trim();
  if (empty.status !== 0 || emptyTree === "")
    return {
      unreadable: `the empty tree cannot be read: ${output(empty) || `exit ${empty.status}`}`,
    };
  const attributes = mergeAttributes(git, ref, tip, emptyTree);
  if (attributes !== null) return { unreadable: attributes };
  const merged = git([
    "--attr-source",
    emptyTree,
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "merge.default=text",
    "merge-tree",
    "--write-tree",
    ref,
    tip,
  ]);
  if (merged.status !== 0 && merged.status !== 1)
    return {
      unreadable: `merging ${tip} into ${ref} failed: ${output(merged) || `exit ${merged.status}`}`,
    };
  if (merged.status === 1) return false;
  const tree = git(["rev-parse", `${ref}^{tree}`]);
  if (tree.status !== 0)
    return {
      unreadable: `${ref}'s tree cannot be read: ${output(tree) || `exit ${tree.status}`}`,
    };
  const [result] = merged.stdout.split("\n");
  return result === tree.stdout.trim();
}

/**
 * The commits on `HEAD` no `remote` branch has whose change the remote's
 * base branch lacks too, newest first, each as `<short hash> <subject>`; or
 * why that cannot be told. A squash merge holds a branch's change under a
 * new commit, so a commit is merged when it, or a commit after it, has the
 * tree of a commit on the base branch, or when its own patch is on the base
 * branch (`git cherry`'s patch-id equivalence); and every commit is merged
 * when merging `HEAD` into the base branch changes nothing.
 */
function unmerged(
  git: (args: string[]) => RunResult,
  remote: string,
): { base: string; commits: string[] } | { unreadable: string } {
  const found = defaultBranch(git, remote);
  if ("unreadable" in found) return found;
  const base = `${remote}/${found.branch}`;
  const ref = `refs/remotes/${base}`;
  const reads = [
    git(["log", "--format=%H %T", "HEAD", "--not", `--remotes=${remote}`]),
    git(["log", "--format=%T", ref, "--not", "HEAD"]),
    git(["cherry", ref, "HEAD"]),
  ].map(lines);
  const failed = reads.find((read) => !Array.isArray(read));
  if (failed !== undefined && !Array.isArray(failed))
    return {
      unreadable: `its commits cannot be compared with ${base}: ${failed.unreadable}`,
    };
  const [ours, theirs, cherry] = reads as string[][];
  const trees = new Set(theirs);
  const merged = (ours ?? [])
    .map((line) => line.split(" "))
    .filter(([, tree]) => tree !== undefined && trees.has(tree))
    .map(([commit]) => commit as string);
  const patched = new Set(
    (cherry ?? [])
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2)),
  );
  const left = lines(
    git([
      "log",
      "--format=%H %h %s",
      "--abbrev=12",
      "HEAD",
      "--not",
      `--remotes=${remote}`,
      ...merged,
    ]),
  );
  if (!Array.isArray(left))
    return {
      unreadable: `its commits cannot be compared with ${base}: ${left.unreadable}`,
    };
  const rows = left
    .map((line) => line.split(" "))
    .filter(([commit]) => commit !== undefined && !patched.has(commit));
  const commits = withoutMergedPrefix(git, remote, ref, rows);
  return Array.isArray(commits)
    ? { base, commits }
    : {
        unreadable: `its commits cannot be compared with ${base}: ${commits.unreadable}`,
      };
}

/**
 * The unmerged commits (`[hash, short hash, ...subject]`, newest first) left
 * once the history merged into the base is taken off, as `<short hash>
 * <subject>`. Merging a tip into the base changes nothing when the base holds
 * that tip's whole history; the newest such tip settles it and every commit
 * before it, so work left on top of a merged prefix stays named.
 */
function withoutMergedPrefix(
  git: (args: string[]) => RunResult,
  remote: string,
  ref: string,
  rows: string[][],
): string[] | { unreadable: string } {
  const named = (list: string[][]) => list.map((row) => row.slice(1).join(" "));
  const tips = ["HEAD", ...rows.map(([commit]) => commit as string)];
  for (const tip of tips.slice(0, MERGE_PROBES)) {
    if (rows.length === 0) break;
    const proof = mergesToNothing(git, ref, tip);
    if (typeof proof === "object") return proof;
    if (!proof) continue;
    const covered = lines(
      git(["log", "--format=%H", tip, "--not", `--remotes=${remote}`]),
    );
    if (!Array.isArray(covered)) return covered;
    const gone = new Set(covered);
    return named(rows.filter(([commit]) => !gone.has(commit as string)));
  }
  return named(rows);
}

/** The commits, the first few by hash and subject and the rest counted. */
function named(commits: string[]): string {
  const shown = commits.slice(0, NAMED_COMMITS).join(", ");
  const more = commits.length - NAMED_COMMITS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * Commits on `HEAD` the remote's copy of the branch lacks, or a reason it
 * cannot be told. With no such branch on the remote, as after a pull
 * request's branch was merged and deleted, only the commits whose change
 * the remote's base branch lacks count (`unmerged`), and they are named.
 */
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
  if (!onRemote) {
    // The other tracking branches vouch for the commits only as the remote has them now.
    // The refspec names the whole namespace the count trusts: a clone that
    // fetches only some branches would otherwise keep a deleted branch's ref.
    const refreshed = git([
      "fetch",
      "--quiet",
      "--prune",
      remote,
      `+refs/heads/*:refs/remotes/${remote}/*`,
    ]);
    if (refreshed.status !== 0)
      return `${remote}'s branches cannot be refreshed to tell whether they hold its commits: ${output(refreshed)}`;
  }
  const counted = git(
    onRemote
      ? ["rev-list", "--count", "HEAD", "--not", ref]
      : ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`],
  );
  const count = Number(counted.stdout.trim());
  if (counted.status !== 0 || !Number.isSafeInteger(count))
    return `its commits cannot be compared with ${remote}: ${output(counted)}`;
  if (count === 0) return null;
  if (onRemote) return `${count} commit(s) not on ${remote}/${branch}`;
  const left = unmerged(git, remote);
  if ("unreadable" in left)
    return `${count} commit(s) on no ${remote} branch, and ${remote} has no ${branch}; whether the base branch holds their change cannot be told: ${left.unreadable}`;
  const { base, commits } = left;
  if (commits.length === 0) return null;
  return `${commits.length} commit(s) on no ${remote} branch whose change ${base} lacks, and ${remote} has no ${branch}: ${named(commits)}`;
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

/**
 * Why index flags may hide a change, or `null`. The superproject's own flags
 * (a gitlink's included) are read without recursion, because a recursive
 * listing shows an active submodule's files instead of its gitlink; every
 * populated submodule, active or not, nested ones too, is then read through
 * `submodule foreach`.
 */
function hiddenChanges(git: Git): string | null {
  const reads = [
    ["ls-files", "-v", "-z"],
    ["submodule", "foreach", "--quiet", "--recursive", "git ls-files -v -z"],
  ];
  for (const args of reads) {
    const flags = git(args);
    if (flags.status !== 0)
      return `its index flags cannot be read: ${output(flags)}`;
    if (hidesIndexChanges(flags.stdout))
      return "assume-unchanged or skip-worktree flags hide possible changes from git status";
  }
  return null;
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
    const started = currentMs();
    const done = ctx.run(argv, {
      timeoutMs,
      ...(cwd === undefined ? {} : { cwd }),
    });
    // The runner reports a killed child as -1; one that ran its whole time was cut short.
    if (done.status === -1 && currentMs() - started >= timeoutMs) cut = true;
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
 * `check.branch`; what keeps it busy when it is not. It changes the working
 * tree and index not at all: the caller refreshes `<remote>/<branch>` first,
 * and only when the remote lacks that branch does the check refresh the
 * remote's other tracking branches, which then vouch for the commits. Once
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
