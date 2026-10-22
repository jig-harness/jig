/**
 * Open a branch as a Herdr worktree workspace, with its agent running:
 * create it, or reattach to the one that already holds the branch.
 *
 * The workspace is ready before an agent starts in it: the repository's
 * create hook has finished (lifecycle.ts).
 *
 * Opening is idempotent by branch. A socket call can succeed while its caller
 * loses the answer, so every run looks before it creates: Herdr's registry
 * and the clone's own `git worktree list` are both read, since a worktree
 * created with plain git is in only one of them. A reattach finishes what an
 * earlier run left undone (the upstream, the agent) instead of only reporting
 * the path.
 *
 * With a reuse prefix, the branch is chosen first: a piece of work that
 * already has a branch, under whatever name it was started with, is opened
 * on that branch instead of a second one beside it.
 */
import { normalizeAgentName, startAgent } from "./agent.ts";
import {
  assertBranchName,
  assertLinkedWorktree,
  branchesWithPrefix,
  decideBranchAction,
  defaultBase,
  ensureUpstreamTracking,
  findGitWorktree,
  probeBranch,
  refreshBaseRef,
  repoIdentity,
  samePath,
} from "./git.ts";
import {
  agentExists,
  createAgentPane,
  findHerdrWorktree,
  herdrJson,
  probeAgentSession,
  reportAgentStatus,
  waitForAgentSettle,
} from "./herdr.ts";
import { awaitCreateHook } from "./lifecycle.ts";
import { type Context, HerdrError, output } from "./runner.ts";

/** How long a start or a reattach waits for the agent to settle by default. */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export interface SpawnOptions {
  /** The clone the worktree is created in. */
  repo: string;
  branch: string;
  /**
   * Open the one existing branch, local or on origin, whose name starts with
   * this instead of `branch`, which must start with it too; `branch` when
   * there is none. Several are refused unless `branch` is one of them.
   */
  reusePrefix?: string;
  /**
   * What a new branch is cut from, e.g. `origin/main`; the clone's
   * `origin/HEAD` when absent, read only when a new branch is created.
   */
  base?: string;
  /** The workspace's label in Herdr; the branch when absent. */
  label?: string;
  /** The Herdr agent kind, e.g. `claude` or `codex`. */
  kind: string;
  /** Open the workspace without starting an agent. */
  noAgent: boolean;
  waitTimeoutMs: number;
}

export interface Spawned {
  path: string;
  /** The branch opened: `--branch`, or the existing one the reuse prefix found. */
  branch: string;
  /** The worktree already existed. */
  reattached: boolean;
  workspaceId: string;
  agentName: string;
  /** The settled state (`idle`, `blocked`, `done`); null without an agent. */
  agentStatus: string | null;
  /** This run started the agent (a fresh workspace, or a reattach that found none). */
  agentStarted: boolean;
  /** A live agent was already running when this run reattached. */
  agentExisted: boolean;
  /** This run started the agent by resuming an earlier session. */
  agentResumed: boolean;
  /** The live agent's session id, when Herdr reports one. */
  agentSessionId: string | null;
  /** Why the session could not be read; null when it was (or there is none). */
  agentSessionError: string | null;
}

type Opened = {
  workspace: { workspace_id: string };
  root_pane: { pane_id: string };
  worktree: { path: string };
  already_open?: boolean;
};

/** The existing worktree for the branch, verified, or null when there is none. */
function existingWorktree(ctx: Context, options: SpawnOptions): string | null {
  const herdr = findHerdrWorktree(ctx, options.repo, options.branch);
  const git = findGitWorktree(ctx, options.repo, options.branch);
  const what = `reattach to ${options.branch}`;
  if (herdr !== null) {
    assertLinkedWorktree(ctx, herdr.path, what);
    // Herdr's registry is its own store: a stale row may name a path git no
    // longer has on this branch, so git's list must confirm it.
    if (git === null || !samePath(git, herdr.path))
      throw new HerdrError(
        `Herdr has ${options.branch} at ${herdr.path}, but the clone's git worktree list does not (it has ${git ?? "nothing"}); not reattaching`,
      );
    ctx.log(`↺ reattaching: ${options.branch} is at ${herdr.path}`);
    return herdr.path;
  }
  if (git !== null) {
    assertLinkedWorktree(ctx, git, what);
    ctx.log(
      `↺ ${options.branch} is checked out at ${git}; opening it in Herdr`,
    );
    return git;
  }
  return null;
}

/** Create the worktree for a branch no checkout holds. */
function createWorktree(ctx: Context, options: SpawnOptions): Opened {
  const { repo, branch } = options;
  const probe = probeBranch(ctx, repo, branch);
  const action = decideBranchAction(probe);
  if (action.kind === "refuse-diverged")
    throw new HerdrError(
      `${branch} has ${action.ahead.length} commit(s) origin lacks; reconcile the branch with origin before opening it`,
    );
  if (action.kind === "create-from-origin" && probe.localExists) {
    // Herdr checks out an existing local branch as it is and ignores the
    // base, so a local copy behind origin is moved to origin first. It is
    // checked out nowhere in this clone, so moving it loses nothing.
    const moved = ctx.run([
      "git",
      "-C",
      repo,
      "branch",
      "-f",
      branch,
      `origin/${branch}`,
    ]);
    if (moved.status !== 0)
      throw new HerdrError(
        `git branch -f failed for ${branch}: ${output(moved)}`,
      );
  }
  const base =
    action.kind === "create-from-base"
      ? (options.base ?? defaultBase(ctx, repo))
      : action.kind === "create-from-origin"
        ? `origin/${branch}`
        : branch;
  if (action.kind === "create-from-base") refreshBaseRef(ctx, repo, base);
  const created = herdrJson<Opened>(
    ctx,
    [
      "herdr",
      "worktree",
      "create",
      "--cwd",
      repo,
      "--branch",
      branch,
      "--base",
      base,
      "--label",
      options.label ?? branch,
      "--no-focus",
    ],
    "herdr worktree create",
  );
  // What Herdr says it created is checked like any other path before
  // anything acts on it.
  assertLinkedWorktree(
    ctx,
    created.worktree.path,
    `use the new worktree for ${branch}`,
  );
  const listed = findGitWorktree(ctx, repo, branch);
  if (listed === null || !samePath(listed, created.worktree.path))
    throw new HerdrError(
      `herdr worktree create reported ${branch} at ${created.worktree.path}, but the clone's git worktree list has ${listed ?? "nothing"}`,
    );
  ctx.log(
    `✓ worktree ${created.worktree.path} (branch ${branch}, from ${base})`,
  );
  return created;
}

/** The branch to open: the one asked for, or the existing one it continues. */
function chooseBranch(ctx: Context, options: SpawnOptions): string {
  const { repo, branch, reusePrefix } = options;
  if (reusePrefix === undefined) return branch;
  const found = branchesWithPrefix(ctx, repo, reusePrefix);
  if (found.length === 0 || found.includes(branch)) return branch;
  const [only, ...more] = found;
  if (only === undefined || more.length > 0)
    throw new HerdrError(
      `several branches start with ${reusePrefix}: ${found.join(", ")}; open the one to continue by its name, without --reuse-prefix`,
    );
  ctx.log(`↺ ${only} already starts with ${reusePrefix}; opening it`);
  return only;
}

export function spawnWorkspace(ctx: Context, requested: SpawnOptions): Spawned {
  assertBranchName(ctx, requested.branch);
  const options = { ...requested, branch: chooseBranch(ctx, requested) };
  if (options.branch !== requested.branch)
    assertBranchName(ctx, options.branch);
  // Resolved before anything is created, so a clone that cannot be
  // identified fails with nothing left behind.
  const agentName = normalizeAgentName(
    options.branch,
    repoIdentity(ctx, options.repo),
  );
  const existing = existingWorktree(ctx, options);
  const opened =
    existing === null
      ? createWorktree(ctx, options)
      : herdrJson<Opened>(
          ctx,
          [
            "herdr",
            "worktree",
            "open",
            "--cwd",
            options.repo,
            "--path",
            existing,
            "--label",
            options.label ?? options.branch,
            "--no-focus",
          ],
          "herdr worktree open",
        );
  const reattached = existing !== null;
  const workspaceId = opened.workspace.workspace_id;
  ensureUpstreamTracking(ctx, options.repo, options.branch);
  awaitCreateHook(ctx, opened.worktree.path);

  const spawned: Spawned = {
    path: opened.worktree.path,
    branch: options.branch,
    reattached,
    workspaceId,
    agentName,
    agentStatus: null,
    agentStarted: false,
    agentExisted: false,
    agentResumed: false,
    agentSessionId: null,
    agentSessionError: null,
  };
  if (options.noAgent) return spawned;

  if (reattached && agentExists(ctx, agentName)) {
    spawned.agentExisted = true;
    spawned.agentStatus = waitForAgentSettle(
      ctx,
      agentName,
      options.waitTimeoutMs,
    );
    // Read after the wait: a person may restart the agent under the same name
    // while it runs, and the session read before would name the old process.
    const probe = probeAgentSession(ctx, agentName);
    spawned.agentSessionId = probe.ok ? probe.sessionId : null;
    spawned.agentSessionError = probe.ok ? null : probe.message;
    reportAgentStatus(ctx, agentName, spawned.agentStatus);
    return spawned;
  }
  // A workspace that was already open may have a command running in its
  // first pane, so the agent gets a tab of its own; a workspace this run
  // opened has a fresh shell there.
  const pane =
    reattached && opened.already_open !== false
      ? createAgentPane(ctx, workspaceId, opened.worktree.path)
      : opened.root_pane.pane_id;
  const started = startAgent(
    ctx,
    agentName,
    pane,
    options.kind,
    options.waitTimeoutMs,
  );
  spawned.agentStarted = true;
  spawned.agentStatus = started.status;
  spawned.agentResumed = started.resumed;
  spawned.agentSessionId = started.sessionId;
  spawned.agentSessionError = started.sessionError;
  return spawned;
}
