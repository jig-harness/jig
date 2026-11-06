/**
 * The git half of opening a workspace: decide where the branch comes from,
 * find a checkout that already holds it, and keep its upstream right.
 *
 * Every probe fails closed. A git call that could not answer (a transport
 * error, a timeout, an unreadable repository) is an error, never "absent":
 * reading a failed `ls-remote` as "the branch is not on origin" would create
 * a second branch beside the one a pull request already tracks, and reading a
 * failed `worktree list` as "not checked out" would create a duplicate
 * checkout.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type Context, HerdrError, output } from "./runner.ts";

/** Pause before the one retry of a fetch another process may be racing. */
export const FETCH_RETRY_DELAY_MS = 3_000;

export type BranchAction =
  /** Neither side has the branch: create it from the base. */
  | { kind: "create-from-base" }
  /** Origin has it, and any local copy holds nothing origin lacks. */
  | { kind: "create-from-origin" }
  /** Only the local branch exists. */
  | { kind: "use-local" }
  /** Local holds commits origin lacks: a person decides. */
  | { kind: "refuse-diverged"; ahead: string[] };

export interface BranchProbe {
  remoteExists: boolean;
  localExists: boolean;
  /** Commits on the local branch that origin's lacks; empty unless both exist. */
  localAhead: string[];
}

/** Whether two paths name the same directory, symbolic links resolved. */
export function samePath(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(a) === real(b);
}

/** The clone's default branch on origin, for a new branch with no base given. */
export function defaultBase(ctx: Context, repo: string): string {
  const head = ctx.run([
    "git",
    "-C",
    repo,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (head.status !== 0 || head.stdout.trim() === "")
    throw new HerdrError(
      `${repo} has no origin/HEAD to cut new branches from (${output(head) || "unset"}); pass --base, or run git remote set-head origin --auto in it`,
    );
  return head.stdout.trim();
}

export function decideBranchAction(probe: BranchProbe): BranchAction {
  if (probe.localExists && probe.remoteExists)
    return probe.localAhead.length === 0
      ? { kind: "create-from-origin" }
      : { kind: "refuse-diverged", ahead: probe.localAhead };
  if (probe.localExists) return { kind: "use-local" };
  if (probe.remoteExists) return { kind: "create-from-origin" };
  return { kind: "create-from-base" };
}

/** Refuse a branch name git would not accept, before anything is created. */
export function assertBranchName(ctx: Context, branch: string): void {
  const checked = ctx.run(["git", "check-ref-format", "--branch", branch]);
  if (checked.status !== 0)
    throw new HerdrError(`"${branch}" is not a valid branch name`);
}

/**
 * Refresh `refs/remotes/origin/<branch>` from origin, and delete it when
 * origin no longer has the branch.
 *
 * The refspec names its destination: a clone fetching only some branches
 * would otherwise report success without writing the ref the caller is about
 * to trust. A fetch that fails because the branch is not on origin is an
 * answer, not a failure, but it does not prune the ref an earlier fetch left,
 * so that ref is deleted here; otherwise it would read as a branch that still
 * exists. Any other failure is retried once, since two launches sharing a
 * clone race each other's ref updates, and then thrown.
 */
function fetchBranchRef(ctx: Context, repo: string, branch: string): void {
  const argv = [
    "git",
    "-C",
    repo,
    "fetch",
    "--prune",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ];
  let fetched = ctx.run(argv);
  if (fetched.status !== 0 && !missingOnOrigin(fetched.stderr)) {
    ctx.log("⚠ git fetch failed (another fetch in this clone?); retrying once");
    ctx.sleep(FETCH_RETRY_DELAY_MS);
    fetched = ctx.run(argv);
  }
  if (fetched.status === 0) return;
  if (!missingOnOrigin(fetched.stderr))
    throw new HerdrError(`git fetch failed for ${branch}: ${output(fetched)}`);
  const deleted = ctx.run([
    "git",
    "-C",
    repo,
    "update-ref",
    "-d",
    `refs/remotes/origin/${branch}`,
  ]);
  if (deleted.status !== 0)
    throw new HerdrError(
      `git update-ref -d failed for origin/${branch}: ${output(deleted)}`,
    );
}

function missingOnOrigin(stderr: string): boolean {
  return /couldn't find remote ref/.test(stderr);
}

/** Whether a ref exists: `--verify --quiet` exits 1 for absent, anything else is a failure. */
function refExists(
  ctx: Context,
  repo: string,
  argv: string[],
  what: string,
): boolean {
  const result = ctx.run(["git", "-C", repo, ...argv]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new HerdrError(
    `cannot tell whether ${what} exists (git exited ${result.status}): ${output(result)}`,
  );
}

/**
 * Where the branch stands locally and on origin.
 *
 * `ls-remote` runs first, as the transport check: its exit 2 means "no such
 * ref" and any other failure means origin could not be asked. Whether origin
 * has the branch is then read from the ref the fetch just wrote, not from
 * `ls-remote`'s answer, which a branch pushed in between would have made
 * stale.
 */
export function probeBranch(
  ctx: Context,
  repo: string,
  branch: string,
): BranchProbe {
  const listed = ctx.run([
    "git",
    "-C",
    repo,
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    branch,
  ]);
  if (listed.status !== 0 && listed.status !== 2)
    throw new HerdrError(
      `git ls-remote failed (exit ${listed.status}): cannot tell whether ${branch} exists on origin: ${output(listed)}`,
    );
  fetchBranchRef(ctx, repo, branch);
  const remoteExists = refExists(
    ctx,
    repo,
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    `origin/${branch}`,
  );
  const localExists = refExists(
    ctx,
    repo,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    `local branch ${branch}`,
  );
  let localAhead: string[] = [];
  if (localExists && remoteExists) {
    const ahead = ctx.run([
      "git",
      "-C",
      repo,
      "rev-list",
      `origin/${branch}..${branch}`,
    ]);
    if (ahead.status !== 0)
      throw new HerdrError(
        `git rev-list failed for ${branch}: ${output(ahead)}`,
      );
    localAhead = ahead.stdout.split("\n").filter(Boolean);
  }
  return { remoteExists, localExists, localAhead };
}

/**
 * The branches whose names start with `prefix`, local or on origin, sorted
 * and each named once. Both sides are read: a branch started and never
 * pushed is only local, and one pushed from another clone only on origin.
 */
export function branchesWithPrefix(
  ctx: Context,
  repo: string,
  prefix: string,
): string[] {
  const local = ctx.run([
    "git",
    "-C",
    repo,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/",
  ]);
  if (local.status !== 0)
    throw new HerdrError(
      `git for-each-ref failed: cannot tell which branches start with ${prefix}: ${output(local)}`,
    );
  const remote = ctx.run(["git", "-C", repo, "ls-remote", "--heads", "origin"]);
  if (remote.status !== 0)
    throw new HerdrError(
      `git ls-remote failed (exit ${remote.status}): cannot tell which branches start with ${prefix} on origin: ${output(remote)}`,
    );
  const names = [
    ...local.stdout.split("\n"),
    ...remote.stdout.split("\n").map((line) => line.split("\t")[1] ?? ""),
  ]
    .map((ref) => ref.trim())
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length))
    .filter((name) => name.startsWith(prefix));
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/**
 * Point the branch's upstream at `origin/<branch>` when origin has it; a
 * branch never pushed has nothing to track. Runs on every path, reattaching
 * included, after refreshing the ref, so a repair an earlier run could not
 * finish is made on the next one.
 */
export function ensureUpstreamTracking(
  ctx: Context,
  repo: string,
  branch: string,
): void {
  fetchBranchRef(ctx, repo, branch);
  if (
    !refExists(
      ctx,
      repo,
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      `origin/${branch}`,
    )
  )
    return;
  const tracked = ctx.run([
    "git",
    "-C",
    repo,
    "branch",
    "--set-upstream-to",
    `origin/${branch}`,
    branch,
  ]);
  if (tracked.status !== 0)
    throw new HerdrError(
      `git branch --set-upstream-to failed for ${branch}: ${output(tracked)}`,
    );
}

/**
 * Refresh the origin branch a new branch is about to be cut from, so it is
 * not cut from a stale base that lacks what was merged since this clone last
 * fetched. A base that is not an origin branch (a commit, a tag, a local
 * branch) is used as given. Unlike a feature branch, a base origin does not
 * have is an error: the worktree would be cut from whatever stale ref is left.
 */
export function refreshBaseRef(ctx: Context, repo: string, base: string): void {
  const match = /^(?:refs\/remotes\/)?origin\/(.+)$/.exec(base);
  const branch = match?.[1];
  if (branch === undefined || branch === "HEAD") {
    ctx.log(`⚠ base ${base} is not an origin branch; using it without a fetch`);
    return;
  }
  const argv = [
    "git",
    "-C",
    repo,
    "fetch",
    "--prune",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ];
  let fetched = ctx.run(argv);
  if (fetched.status !== 0) {
    ctx.log("⚠ git fetch of the base failed; retrying once");
    ctx.sleep(FETCH_RETRY_DELAY_MS);
    fetched = ctx.run(argv);
  }
  if (fetched.status !== 0)
    throw new HerdrError(
      `git fetch failed for base ${base}: ${output(fetched)}; not creating a worktree from a base this clone could not refresh`,
    );
}

export interface GitWorktreeRow {
  path: string;
  /** The checked-out branch without `refs/heads/`; null when detached. */
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain -z`. The `-z` form writes each path as
 * it is; without it git quotes a path holding a tab, a newline, a quote or a
 * non-ASCII byte, and the quoted text names no real directory.
 */
export function parseGitWorktreeList(porcelain: string): GitWorktreeRow[] {
  const rows: GitWorktreeRow[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  const flush = (): void => {
    if (path) rows.push({ path, branch });
    path = null;
    branch = null;
  };
  for (const line of porcelain.split("\0")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return rows;
}

/** The checkout in this clone that has the branch checked out, or null. */
export function findGitWorktree(
  ctx: Context,
  repo: string,
  branch: string,
): string | null {
  const listed = ctx.run([
    "git",
    "-C",
    repo,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (listed.status !== 0)
    throw new HerdrError(`git worktree list failed: ${output(listed)}`);
  return (
    parseGitWorktreeList(listed.stdout).find((row) => row.branch === branch)
      ?.path ?? null
  );
}

/**
 * Refuse a path that is not a linked worktree: the primary checkout holds the
 * clone itself, and a workspace step must never act on it as if it were a
 * disposable worktree.
 */
export function assertLinkedWorktree(
  ctx: Context,
  path: string,
  what: string,
): void {
  const gitDir = ctx.run([
    "git",
    "-C",
    path,
    "rev-parse",
    "--absolute-git-dir",
  ]);
  const commonDir = ctx.run([
    "git",
    "-C",
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (gitDir.status !== 0 || commonDir.status !== 0)
    throw new HerdrError(`${path} is not a git checkout; not going to ${what}`);
  if (gitDir.stdout.trim() === commonDir.stdout.trim())
    throw new HerdrError(
      `${path} is the clone's primary checkout, not a linked worktree; not going to ${what}`,
    );
}

/**
 * A clone's identity: its git common directory, absolute. Every worktree of
 * one clone shares it and no two clones do, so it scopes names that must be
 * unique per clone and branch. A repository it cannot be read from is an
 * error, never an unscoped name that could collide with another clone's.
 */
export function repoIdentity(ctx: Context, repo: string): string {
  const result = ctx.run([
    "git",
    "-C",
    repo,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.status !== 0 || result.stdout.trim() === "")
    throw new HerdrError(
      `cannot read the git common directory of ${repo} (exit ${result.status}): ${output(result)}`,
    );
  return resolve(result.stdout.trim());
}
