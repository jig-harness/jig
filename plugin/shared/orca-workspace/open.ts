/**
 * Open a branch's Orca worktree: reattach to the checkout that already holds
 * the branch, or create one through Orca and give it the branch asked for
 * (Orca names a new branch after the worktree, under its own prefix), keep
 * the branch's upstream right, and run the repository's create hook once.
 *
 * Every path Orca reports is checked against git before anything acts on it:
 * a stale or wrong answer must not have this code rename or delete branches
 * in a checkout it was not asked about. The Orca workspace tool
 * (tools/orca/workspace.ts) opens through these rules and adds what an
 * agent's start needs; `openBranch` is the whole open for a caller that
 * starts its agent another way.
 */
import { recordOf, textOf, OrcaError, orcaErrorText } from "./envelope.ts";
import {
  assertBranchName,
  assertLinkedWorktree,
  type BranchAction,
  branchesWithPrefix,
  decideBranchAction,
  defaultBase,
  ensureUpstreamTracking,
  findGitWorktree,
  probeBranch,
  refreshBaseRef,
} from "./git.ts";
import { ensureCreateHook, gitDirOf } from "./hooks.ts";
import { type OpenPort, orcaResult } from "./port.ts";
import { output } from "./runner.ts";

/** A repository as Orca knows it: its id and its clone's path on Orca's machine. */
export interface OrcaRepo {
  id: string;
  path: string;
}

export interface OrcaWorktree {
  id: string;
  path: string;
  /** Without `refs/heads/`. */
  branch: string;
}

/** Whether two path texts name the same directory, trailing slashes aside. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * The repository Orca knows by `name`. When Orca has none by that name,
 * `onMissing` (a clone of it, say) supplies Orca's answer for it, as
 * `orca repo show` gives it; without one, the open stops.
 */
export function repoOf(
  port: OpenPort,
  name: string,
  onMissing?: (name: string) => unknown,
): OrcaRepo {
  const what = `orca repo show ${name}`;
  const envelope = port.orcaCall<{ repo?: unknown }>(
    ["repo", "show", "--repo", `name:${name}`],
    what,
  );
  let found: unknown;
  if (envelope.ok) found = envelope.result?.repo;
  else if (envelope.error.code !== "repo_not_found")
    throw new OrcaError(`${what}: ${orcaErrorText(envelope.error)}`);
  else if (onMissing !== undefined) found = onMissing(name);
  else
    throw new OrcaError(
      `Orca${port.where} has no repository named ${name}; add the clone there with orca repo add --path <clone>, or name one of orca repo list`,
    );
  const repo = recordOf(found, what);
  return { id: textOf(repo, "id", what), path: textOf(repo, "path", what) };
}

function worktreeOf(value: unknown, what: string): OrcaWorktree {
  const row = recordOf(value, what);
  const branch = row.branch;
  return {
    id: textOf(row, "id", what),
    path: textOf(row, "path", what),
    // A detached checkout (a clone kept at a tag) has no branch.
    branch:
      typeof branch === "string" ? branch.replace(/^refs\/heads\//, "") : "",
  };
}

/** The branch checked out at `path`, read from git itself. */
function checkedOutBranch(port: OpenPort, path: string, what: string): string {
  const head = port.host.run([
    "git",
    "-C",
    path,
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  if (head.status !== 0 || head.stdout.trim() === "")
    throw new OrcaError(
      `${what} left ${path} with no branch checked out: ${output(head)}`,
    );
  return head.stdout.trim();
}

/** The git common directory of the checkout at `path`, as the host reports it. */
function commonDirOf(port: OpenPort, path: string): string {
  const dir = port.host.run([
    "git",
    "-C",
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (dir.status !== 0 || dir.stdout.trim() === "")
    throw new OrcaError(
      `cannot read the git common directory of ${path}: ${output(dir)}`,
    );
  return dir.stdout.trim();
}

/**
 * Refuse a path that is not a worktree of the repository's own clone before
 * anything mutates a branch in it: a linked worktree of another clone passes
 * the linked-worktree check, and a stale or wrong answer from Orca must not
 * have this code rename or delete branches in a repository it was not asked
 * about.
 */
function assertWorktreeOf(
  port: OpenPort,
  repo: OrcaRepo,
  path: string,
  what: string,
): void {
  const clone = commonDirOf(port, repo.path);
  const own = commonDirOf(port, path);
  if (!sameText(clone, own))
    throw new OrcaError(
      `${what} reported a worktree at ${path}, which belongs to the clone at ${own}, not to ${repo.path}'s (${clone}); not touching it`,
    );
}

/** Orca's row for the checkout at `path`, or null when Orca does not list it. */
export function listedWorktree(
  port: OpenPort,
  repo: OrcaRepo,
  path: string,
): OrcaWorktree | null {
  const what = "orca worktree list";
  const listed = recordOf(
    orcaResult(port, ["worktree", "list", "--repo", `id:${repo.id}`], what),
    what,
  );
  if (!Array.isArray(listed.worktrees))
    throw new OrcaError(`${what}: no worktrees in the answer`);
  for (const row of listed.worktrees) {
    const worktree = worktreeOf(row, what);
    if (sameText(worktree.path, path)) return worktree;
  }
  return null;
}

/**
 * The worktree that already holds the branch, as Orca lists it, or null.
 * A checkout made with plain git that Orca hides is refused rather than
 * duplicated: Orca shows such checkouts when asked to.
 */
function existingWorktree(
  port: OpenPort,
  repo: OrcaRepo,
  branch: string,
): OrcaWorktree | null {
  const path = findGitWorktree(port.host, repo.path, branch);
  if (path === null) return null;
  assertLinkedWorktree(port.host, path, `reattach to ${branch}`);
  const row = listedWorktree(port, repo, path);
  if (row === null)
    throw new OrcaError(
      `${branch} is checked out at ${path}, which Orca${port.where} does not list; show the repository's non-Orca worktrees (orca repo set --repo id:${repo.id} --external-worktree-visibility show) and open it again, or remove that checkout`,
    );
  port.host.log(`↺ reattaching: ${branch} is at ${path}`);
  return row;
}

/** Where a new checkout of the branch starts, as `decideBranchAction` chose it. */
type Start = Exclude<BranchAction, { kind: "refuse-diverged" }>["kind"];

/**
 * Give the new checkout the branch asked for. Orca names a new branch after
 * the worktree, under its own prefix, so the checkout is moved onto the
 * branch (a fresh one is renamed; an existing one, on origin or local, is
 * checked out) and Orca's branch deleted. Orca reads the branch from git,
 * so it follows.
 */
function nameBranch(
  port: OpenPort,
  created: OrcaWorktree,
  branch: string,
  start: Start,
): void {
  if (created.branch === branch) return;
  const git = (...args: string[]): void => {
    const done = port.host.run(["git", "-C", created.path, ...args]);
    if (done.status !== 0)
      throw new OrcaError(
        `git ${args[0]} failed in ${created.path}: ${output(done)}`,
      );
  };
  if (start === "create-from-base") {
    git("branch", "-m", created.branch, branch);
    return;
  }
  if (start === "create-from-origin")
    git("checkout", "--quiet", "-B", branch, `origin/${branch}`);
  else git("checkout", "--quiet", branch);
  git("branch", "-D", created.branch);
}

/**
 * The branch to open: the one asked for, or the one existing branch, local
 * or on origin, that starts with the reuse prefix, which it continues. The
 * Herdr workspace tool chooses by the same rule.
 */
export function chooseBranch(
  port: OpenPort,
  clone: string,
  branch: string,
  reusePrefix: string | undefined,
): string {
  if (reusePrefix === undefined) return branch;
  const found = branchesWithPrefix(port.host, clone, reusePrefix);
  if (found.length === 0 || found.includes(branch)) return branch;
  const [only, ...more] = found;
  if (only === undefined || more.length > 0)
    throw new OrcaError(
      `several branches start with ${reusePrefix}: ${found.join(", ")}; open the one to continue by its name, without --reuse-prefix`,
    );
  port.host.log(`↺ ${only} already starts with ${reusePrefix}; opening it`);
  return only;
}

/** Where the new checkout starts: origin's copy, the local branch, or the refreshed base (the clone's `origin/HEAD` when `base` is absent). */
function startRef(
  port: OpenPort,
  repo: OrcaRepo,
  base: string | undefined,
  branch: string,
  start: Start,
): string {
  if (start === "create-from-origin") return `origin/${branch}`;
  if (start === "use-local") return branch;
  const from = base ?? defaultBase(port.host, repo.path);
  refreshBaseRef(port.host, repo.path, from);
  return from;
}

/** What a new worktree is created with, beyond its branch. */
export interface CreateOptions {
  /** What a new branch is cut from; the clone's `origin/HEAD` when absent. */
  base?: string;
  /** A comment kept in Orca's metadata for the worktree. */
  comment?: string;
  /** More arguments for `orca worktree create`, after the comment (`--activate`, say). */
  createFlags?: string[];
}

/** `orca worktree create`'s arguments: the repository's own setup is skipped, since the hook runs once the branch has its name. */
function createArgs(
  repo: OrcaRepo,
  options: CreateOptions,
  branch: string,
  from: string,
): string[] {
  return [
    "worktree",
    "create",
    "--repo",
    `id:${repo.id}`,
    "--name",
    branch,
    "--base-branch",
    from,
    "--no-parent",
    "--setup",
    "skip",
    ...(options.comment === undefined ? [] : ["--comment", options.comment]),
    ...(options.createFlags ?? []),
  ];
}

/** Create the worktree for a branch no checkout holds. */
function createWorktree(
  port: OpenPort,
  repo: OrcaRepo,
  options: CreateOptions,
  branch: string,
): OrcaWorktree {
  const action = decideBranchAction(probeBranch(port.host, repo.path, branch));
  if (action.kind === "refuse-diverged")
    throw new OrcaError(
      `${branch} has ${action.ahead.length} commit(s) origin lacks; reconcile the branch with origin before opening it`,
    );
  const from = startRef(port, repo, options.base, branch, action.kind);
  const what = "orca worktree create";
  const created = worktreeOf(
    recordOf(
      orcaResult(port, createArgs(repo, options, branch, from), what),
      what,
    ).worktree,
    what,
  );
  // What Orca says it created is checked like any other path before
  // anything acts on it: a linked worktree, and one of this repository's
  // clone. The branch it gave is read from git, not from the answer, since
  // the branch is what is renamed next.
  assertLinkedWorktree(
    port.host,
    created.path,
    `use the new worktree for ${branch}`,
  );
  assertWorktreeOf(port, repo, created.path, what);
  nameBranch(
    port,
    { ...created, branch: checkedOutBranch(port, created.path, what) },
    branch,
    action.kind,
  );
  const listed = findGitWorktree(port.host, repo.path, branch);
  if (listed === null || !sameText(listed, created.path))
    throw new OrcaError(
      `${what} reported ${branch} at ${created.path}, but the clone's git worktree list has ${listed ?? "nothing"}`,
    );
  port.host.log(`✓ worktree ${created.path} (branch ${branch}, from ${from})`);
  return { ...created, branch };
}

/** Set one of the worktree's Orca metadata fields; the reason it failed, or null. */
export function setWorktree(
  port: OpenPort,
  worktree: OrcaWorktree,
  flag: string,
  value: string,
): string | null {
  const what = "orca worktree set";
  try {
    const envelope = port.orcaCall(
      ["worktree", "set", "--worktree", `id:${worktree.id}`, flag, value],
      what,
    );
    return envelope.ok ? null : orcaErrorText(envelope.error);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The branch's worktree, reattached or created, with its upstream tracking
 * right. The tracking is checked on every path, reattaching included: a
 * repair an earlier open could not finish is made now.
 */
export function attachBranch(
  port: OpenPort,
  repo: OrcaRepo,
  branch: string,
  options: CreateOptions = {},
): { worktree: OrcaWorktree; reattached: boolean } {
  const found = existingWorktree(port, repo, branch);
  const worktree = found ?? createWorktree(port, repo, options, branch);
  ensureUpstreamTracking(port.host, repo.path, branch);
  return { worktree, reattached: found !== null };
}

export interface OpenBranchOptions extends CreateOptions {
  /** The repository: as `orca repo list` gives it, or its name in Orca, which `orca repo show` resolves. */
  repo: OrcaRepo | string;
  branch: string;
}

export interface OpenedBranch {
  repo: OrcaRepo;
  worktree: OrcaWorktree;
  /** The worktree already existed. */
  reattached: boolean;
  /** This open ran the repository's create hook. */
  hookRan: boolean;
}

/**
 * Open the branch's worktree and run the repository's create hook in it
 * once, waiting for another open that is running it. An existing pull
 * request's head branch is reattached where a checkout holds it, or checked
 * out from origin in a new worktree.
 */
export function openBranch(
  port: OpenPort,
  options: OpenBranchOptions,
): OpenedBranch {
  assertBranchName(port.host, options.branch);
  const repo =
    typeof options.repo === "string"
      ? repoOf(port, options.repo)
      : options.repo;
  const { worktree, reattached } = attachBranch(
    port,
    repo,
    options.branch,
    options,
  );
  const hookRan = ensureCreateHook(
    port,
    worktree.path,
    gitDirOf(port, worktree.path),
  );
  return { repo, worktree, reattached, hookRan };
}
