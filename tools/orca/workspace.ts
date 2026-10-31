#!/usr/bin/env bun
/**
 * Open and remove Orca worktree workspaces, in Orca on this machine or on a
 * paired Orca server.
 *
 * Usage:
 *   bun tools/orca/workspace.ts open --repo <name> --branch <name> [--environment <name> --ssh <host>]
 *       [--reuse-prefix <text>] [--base <ref>] [--agent <id>] [--no-agent] [--prompt <text>] [--key <key>]
 *       [--comment <text>] [--linear-issue <key>] [--activate] [--clone-url <url> --clone-root <dir>]
 *       [--model <id> [--effort <level>]] [--surface chat|terminal] [--json]
 *   bun tools/orca/workspace.ts remove --repo <name> --branch <name> [--environment <name> --ssh <host>] [--force]
 *
 * `open` creates the branch's worktree through Orca, or reattaches to the
 * checkout that already holds the branch, names the branch as asked (Orca
 * names a new branch after the worktree, under its own prefix), runs the
 * repository's create hook once, and starts the agent with the prompt once
 * per `--key` and agent. With `--reuse-prefix`, the one existing branch whose
 * name starts with it is opened instead of `--branch`. With `--clone-url`
 * and `--clone-root`, a repository Orca does not have is cloned into
 * `<root>/<repo>` and added to Orca first (clone.ts). With `--no-agent` the
 * create hook runs in the worktree's `setup` tab and `open` returns without
 * waiting for it; an agent it starts waits for the hook. `--json` prints what
 * was opened; progress goes to stderr.
 *
 * `remove` runs the repository's remove hook in the worktree, parks its
 * reflection findings when the clone is on this machine (and refuses while a
 * worktree on a server's host holds unsent ones), and removes the worktree
 * through Orca, refusing when a step fails.
 *
 * `--environment` names a paired Orca server (`orca environment list`); Orca's
 * tool runs here and reaches the server, while git and the hooks run on the
 * server's host over SSH, which `--ssh` names. Both clones are reached the
 * same way, so a step reads one interface (runner.ts).
 *
 * Exit codes: 0 done; 1 the step failed (the message says what to do);
 * 2 usage.
 */
import { cli, strictOptions } from "../../lib/cli.ts";
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
} from "../herdr/git.ts";
import { CLAIM_WAIT_MS, KICKOFF_KEY } from "../herdr/kickoff.ts";
import {
  type RemovalSteps,
  removeThroughOrca,
  WorktreeRemovalError,
} from "../../plugin/gc/worktree-removal.ts";
import {
  HOOK_TIMEOUT_MS,
  PARK_TIMEOUT_MS,
  parkJournal,
} from "../herdr/lifecycle.ts";
import { UsageError } from "../herdr/options.ts";
import { ownerLine } from "../herdr/owner.ts";
import {
  COMMAND_TIMEOUT_MS,
  type Context,
  output,
  withLimit,
} from "../herdr/runner.ts";
import {
  onServer,
  orcaArgv,
  orcaCall,
  orcaErrorText,
  orcaJson,
  recordOf,
  resolveOrcaCommand,
  textOf,
} from "./cli.ts";
import {
  CLONE_TIMEOUT_MS,
  type CloneSource,
  cloneMissingRepo,
} from "./clone.ts";
import {
  startCreateHook,
  assertNoUnsentFindings,
  ensureCreateHook,
  gitDirOf,
  hookOf,
} from "./hooks.ts";
import {
  claimReceipt,
  clearReceipt,
  type Receipt,
  receiptPath,
  writeReceipt,
} from "./receipts.ts";
import { OrcaError, type Workspace, workspace } from "./runner.ts";
import { worktreeToken } from "./worktree-token.ts";

export { CREATE_HOOK_CLAIM, CREATE_HOOK_MARK } from "./hooks.ts";
export { fileSegment, type Receipt, receiptPath } from "./receipts.ts";

export const USAGE = `usage:
  workspace.ts open --repo <name> --branch <name> [--environment <name> --ssh <host>] [--reuse-prefix <text>]
      [--base <ref>] [--agent <id>] [--no-agent] [--prompt <text>] [--key <key>] [--comment <text>]
      [--linear-issue <key>] [--activate] [--clone-url <url> --clone-root <dir>]
      [--model <id> [--effort <level>]] [--surface chat|terminal] [--json]
  workspace.ts remove --repo <name> --branch <name> [--environment <name> --ssh <host>] [--force]`;

/**
 * The calls around the hook: git probes, fetches and the clone checks, Orca's
 * list, create, link and launch, the worktree's git directory, the hook's
 * claim and mark, the worktree's token, where the journal is and its read.
 */
const COMMAND_ALLOWANCE = 30;
/** The time `open` may take: a clone, the create hook, waiting for another open's start of the agent, and the calls around them. */
export const OPEN_LIMIT_MS =
  CLONE_TIMEOUT_MS +
  HOOK_TIMEOUT_MS +
  CLAIM_WAIT_MS +
  COMMAND_ALLOWANCE * COMMAND_TIMEOUT_MS;
/** The time `remove` may take: the remove hook, parking, and the calls around them. */
export const REMOVE_LIMIT_MS =
  HOOK_TIMEOUT_MS + PARK_TIMEOUT_MS + COMMAND_ALLOWANCE * COMMAND_TIMEOUT_MS;

export interface OpenOptions {
  /** The repository's name in Orca (`orca repo list`). */
  repo: string;
  branch: string;
  /**
   * Open the one existing branch, local or on origin, whose name starts with
   * this instead of `branch`, which must start with it too; `branch` when
   * there is none. Several are refused unless `branch` is one of them.
   */
  reusePrefix?: string;
  /** What a new branch is cut from; the clone's `origin/HEAD` when absent. */
  base?: string;
  /** The Orca agent id to start, e.g. `claude` or `codex`. */
  agent: string;
  /** Open the workspace without starting an agent. */
  noAgent: boolean;
  /** The agent's first prompt. */
  prompt?: string;
  /** The key the agent's start is recorded under, so a second open does not start it again. */
  key?: string;
  /** A comment kept in Orca's metadata for the worktree. */
  comment?: string;
  /** An issue to link in Orca's Linear integration; a link that fails only warns. */
  linearIssue?: string;
  /** Reveal a new worktree in the Orca app. */
  activate: boolean;
  /** Clone the repository from here and add it to Orca when Orca does not have it. */
  clone?: CloneSource;
  /** The agent's model, as Orca's provider names it; the agent's default when absent. */
  model?: string;
  /** The model's reasoning effort; needs `model`. */
  effort?: string;
  /** Start the agent as a chat or in a terminal; Orca's Chat UI setting when absent. */
  surface?: "chat" | "terminal";
}

export interface Opened {
  path: string;
  /** The branch opened: the one asked for, or the existing one the reuse prefix found. */
  branch: string;
  worktreeId: string;
  /** The worktree already existed. */
  reattached: boolean;
  /** This run ran the repository's create hook, or started it in the worktree's `setup` tab. */
  hookRan: boolean;
  /** The create hook runs in the worktree's `setup` tab rather than before this run returned. */
  setupInTab?: boolean;
  /** This run started the agent. */
  agentLaunched: boolean;
  /** The agent's start under `key`: by this run, by an earlier one, or not recorded. */
  kickoff: "sent" | "already-sent" | "none";
}

interface OrcaRepo {
  id: string;
  path: string;
}

interface OrcaWorktree {
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
 * The repository Orca knows by `name`: its id and its clone's path on Orca's
 * machine. With `clone`, a repository Orca does not have is cloned and added
 * first.
 */
function repoOf(ws: Workspace, name: string, clone?: CloneSource): OrcaRepo {
  const what = `orca repo show ${name}`;
  const envelope = orcaCall<{ repo?: unknown }>(
    ws,
    ["repo", "show", "--repo", `name:${name}`],
    what,
  );
  let found: unknown;
  if (envelope.ok) found = envelope.result?.repo;
  else if (envelope.error.code !== "repo_not_found")
    throw new OrcaError(`${what}: ${orcaErrorText(envelope.error)}`);
  else if (clone !== undefined) found = cloneMissingRepo(ws, name, clone);
  else
    throw new OrcaError(
      `Orca${onServer(ws.target)} has no repository named ${name}; add the clone there with orca repo add --path <clone>, or name one of orca repo list`,
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
function checkedOutBranch(ws: Workspace, path: string, what: string): string {
  const head = ws.host.run([
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
function commonDirOf(ws: Workspace, path: string): string {
  const dir = ws.host.run([
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
 * have this tool rename or delete branches in a repository it was not asked
 * about.
 */
function assertWorktreeOf(
  ws: Workspace,
  repo: OrcaRepo,
  path: string,
  what: string,
): void {
  const clone = commonDirOf(ws, repo.path);
  const own = commonDirOf(ws, path);
  if (!sameText(clone, own))
    throw new OrcaError(
      `${what} reported a worktree at ${path}, which belongs to the clone at ${own}, not to ${repo.path}'s (${clone}); not touching it`,
    );
}

/** Orca's row for the checkout at `path`, or null when Orca does not list it. */
function listedWorktree(
  ws: Workspace,
  repo: OrcaRepo,
  path: string,
): OrcaWorktree | null {
  const what = "orca worktree list";
  const listed = recordOf(
    orcaJson(ws, ["worktree", "list", "--repo", `id:${repo.id}`], what),
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
  ws: Workspace,
  repo: OrcaRepo,
  branch: string,
): OrcaWorktree | null {
  const path = findGitWorktree(ws.host, repo.path, branch);
  if (path === null) return null;
  assertLinkedWorktree(ws.host, path, `reattach to ${branch}`);
  const row = listedWorktree(ws, repo, path);
  if (row === null)
    throw new OrcaError(
      `${branch} is checked out at ${path}, which Orca${onServer(ws.target)} does not list; show the repository's non-Orca worktrees (orca repo set --repo id:${repo.id} --external-worktree-visibility show) and open it again, or remove that checkout`,
    );
  ws.host.log(`↺ reattaching: ${branch} is at ${path}`);
  return row;
}

/**
 * Give the new checkout the branch asked for. Orca names a new branch after
 * the worktree, under its own prefix, so the checkout is moved onto the
 * branch (a fresh one is renamed; an existing one, on origin or local, is
 * checked out) and Orca's branch deleted. Orca reads the branch from git,
 * so it follows.
 */
function nameBranch(
  ws: Workspace,
  created: OrcaWorktree,
  branch: string,
  start: Start,
): void {
  if (created.branch === branch) return;
  const git = (...args: string[]): void => {
    const done = ws.host.run(["git", "-C", created.path, ...args]);
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
function chooseBranch(
  ws: Workspace,
  clone: string,
  branch: string,
  reusePrefix: string | undefined,
): string {
  if (reusePrefix === undefined) return branch;
  const found = branchesWithPrefix(ws.host, clone, reusePrefix);
  if (found.length === 0 || found.includes(branch)) return branch;
  const [only, ...more] = found;
  if (only === undefined || more.length > 0)
    throw new OrcaError(
      `several branches start with ${reusePrefix}: ${found.join(", ")}; open the one to continue by its name, without --reuse-prefix`,
    );
  ws.host.log(`↺ ${only} already starts with ${reusePrefix}; opening it`);
  return only;
}

type Start = Exclude<BranchAction, { kind: "refuse-diverged" }>["kind"];

/** Where the new checkout starts: origin's copy, the local branch, or the refreshed base. */
function startRef(
  ws: Workspace,
  repo: OrcaRepo,
  options: OpenOptions,
  branch: string,
  start: Start,
): string {
  if (start === "create-from-origin") return `origin/${branch}`;
  if (start === "use-local") return branch;
  const base = options.base ?? defaultBase(ws.host, repo.path);
  refreshBaseRef(ws.host, repo.path, base);
  return base;
}

/** `orca worktree create`'s arguments: the repository's own setup is skipped, since the hook runs once the branch has its name. */
function createArgs(
  repo: OrcaRepo,
  options: OpenOptions,
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
    ...(options.activate ? ["--activate"] : []),
  ];
}

/** Create the worktree for a branch no checkout holds. */
function createWorktree(
  ws: Workspace,
  repo: OrcaRepo,
  options: OpenOptions,
  branch: string,
): OrcaWorktree {
  const action = decideBranchAction(probeBranch(ws.host, repo.path, branch));
  if (action.kind === "refuse-diverged")
    throw new OrcaError(
      `${branch} has ${action.ahead.length} commit(s) origin lacks; reconcile the branch with origin before opening it`,
    );
  const from = startRef(ws, repo, options, branch, action.kind);
  const what = "orca worktree create";
  const created = worktreeOf(
    recordOf(orcaJson(ws, createArgs(repo, options, branch, from), what), what)
      .worktree,
    what,
  );
  // What Orca says it created is checked like any other path before
  // anything acts on it: a linked worktree, and one of this repository's
  // clone. The branch it gave is read from git, not from the answer, since
  // the branch is what is renamed next.
  assertLinkedWorktree(
    ws.host,
    created.path,
    `use the new worktree for ${branch}`,
  );
  assertWorktreeOf(ws, repo, created.path, what);
  nameBranch(
    ws,
    { ...created, branch: checkedOutBranch(ws, created.path, what) },
    branch,
    action.kind,
  );
  const listed = findGitWorktree(ws.host, repo.path, branch);
  if (listed === null || !sameText(listed, created.path))
    throw new OrcaError(
      `${what} reported ${branch} at ${created.path}, but the clone's git worktree list has ${listed ?? "nothing"}`,
    );
  ws.host.log(`✓ worktree ${created.path} (branch ${branch}, from ${from})`);
  return { ...created, branch };
}

/** Set one of the worktree's Orca metadata fields; the reason it failed, or null. */
function setWorktree(
  ws: Workspace,
  worktree: OrcaWorktree,
  flag: string,
  value: string,
): string | null {
  const what = "orca worktree set";
  try {
    const envelope = orcaCall(
      ws,
      ["worktree", "set", "--worktree", `id:${worktree.id}`, flag, value],
      what,
    );
    return envelope.ok ? null : orcaErrorText(envelope.error);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Link the issue in Orca's Linear integration; a failure only warns, since the link is a convenience. */
function linkIssue(ws: Workspace, worktree: OrcaWorktree, issue: string): void {
  const reason = setWorktree(ws, worktree, "--linear-issue", issue);
  if (reason !== null)
    ws.orca.log(
      `⚠ could not link ${issue} to the worktree in Orca (${reason}); connect Orca's Linear integration to have it linked`,
    );
}

/**
 * Bring a reattached worktree's comment up to date. Creation set the comment
 * an earlier open asked for; with no agent to start, the comment carries the
 * prompt the person pastes on another device, so it is replaced. A failure
 * only warns: the prompt is on this machine's clipboard or printed too.
 */
function updateComment(
  ws: Workspace,
  worktree: OrcaWorktree,
  comment: string,
): void {
  const reason = setWorktree(ws, worktree, "--comment", comment);
  if (reason !== null)
    ws.orca.log(
      `⚠ could not update the worktree's comment in Orca (${reason}); it may hold an earlier prompt`,
    );
}

/** The receipt an open takes before it starts the agent; recorded only when `file` is. */
function pendingReceipt(
  ws: Workspace,
  repo: OrcaRepo,
  worktree: OrcaWorktree,
  dir: string,
  options: OpenOptions,
  file: string | null,
): Receipt {
  const recorded = file !== null;
  return {
    key: options.key ?? "",
    status: "pending",
    repoId: repo.id,
    worktreeId: worktree.id,
    worktreeToken: recorded ? worktreeToken(ws, dir) : "",
    agent: options.agent,
    environment: ws.target.environment ?? null,
    at: new Date().toISOString(),
    ...(recorded ? { owner: ownerLine(ws.orca).trim() } : {}),
  };
}

/**
 * Start the agent, once per key and agent. The receipt carries the
 * worktree's token, read from its git directory `dir` (and published there
 * first by this open when there is none), is taken as pending before the
 * launch and completed once Orca answered. An answer that nothing started
 * (an agent Orca does not have, say) clears the receipt, so the next open
 * starts the agent once the cause is fixed; a call that got no answer
 * leaves it pending, so a start whose outcome is unknown is never repeated
 * by a later open without a person looking first.
 */
function launchAgent(
  ws: Workspace,
  repo: OrcaRepo,
  worktree: OrcaWorktree,
  dir: string,
  options: OpenOptions,
): Pick<Opened, "agentLaunched" | "kickoff"> {
  const key = options.key;
  const file =
    key === undefined ? null : receiptPath(ws, repo.id, key, options.agent);
  const receipt = pendingReceipt(ws, repo, worktree, dir, options, file);
  if (file !== null && !claimReceipt(ws, file, receipt))
    return { agentLaunched: false, kickoff: "already-sent" };
  const prompt =
    options.prompt === undefined ? [] : ["--prompt", options.prompt];
  const what = "orca agent launch";
  const envelope = orcaCall(
    ws,
    [
      "agent",
      "launch",
      "--agent",
      options.agent,
      "--worktree",
      `id:${worktree.id}`,
      ...prompt,
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--effort", options.effort]),
      ...(options.surface === undefined ? [] : ["--surface", options.surface]),
    ],
    what,
  );
  if (!envelope.ok) {
    if (file !== null) clearReceipt(file);
    throw new OrcaError(
      `${what}: ${orcaErrorText(envelope.error)}; nothing was started, so the next open starts the agent once that is fixed`,
    );
  }
  if (file !== null) {
    const { owner: _owner, ...started } = receipt;
    writeReceipt(file, {
      ...started,
      status: "sent",
      launch: envelope.result,
    });
  }
  ws.orca.log(
    `✓ ${options.agent} started in ${worktree.path}${prompt.length === 0 ? "" : " with its first prompt"}`,
  );
  return { agentLaunched: true, kickoff: file === null ? "none" : "sent" };
}

export function openWorkspace(ws: Workspace, requested: OpenOptions): Opened {
  assertBranchName(ws.host, requested.branch);
  const repo = repoOf(ws, requested.repo, requested.clone);
  const branch = chooseBranch(
    ws,
    repo.path,
    requested.branch,
    requested.reusePrefix,
  );
  if (branch !== requested.branch) assertBranchName(ws.host, branch);
  const found = existingWorktree(ws, repo, branch);
  const worktree = found ?? createWorktree(ws, repo, requested, branch);
  // On every path, reattaching included: a tracking repair an earlier open
  // could not finish is made now (the helper's own contract), and a link
  // that failed then (the integration not yet connected) is tried again.
  ensureUpstreamTracking(ws.host, repo.path, branch);
  if (requested.linearIssue !== undefined)
    linkIssue(ws, worktree, requested.linearIssue);
  if (found !== null && requested.noAgent && requested.comment !== undefined)
    updateComment(ws, worktree, requested.comment);
  // The worktree's own git directory: where the create hook's mark and claim
  // are kept, and the token that tells this worktree from one that stood at
  // its path before (worktree-token.ts), which a receipt of the key's agent
  // is read against when the agent is started and nowhere earlier.
  const dir = gitDirOf(ws, worktree.path);
  const opened: Opened = {
    path: worktree.path,
    branch,
    worktreeId: worktree.id,
    reattached: found !== null,
    hookRan: false,
    agentLaunched: false,
    kickoff: "none",
  };
  // With no agent to start, nothing waits for the hook: it runs in a tab the
  // person watches. An agent started here reads the tree, so it waits.
  if (requested.noAgent) {
    const setup = startCreateHook(ws, worktree, dir);
    return {
      ...opened,
      hookRan: setup === "started",
      setupInTab: setup === "started" || setup === "running",
    };
  }
  opened.hookRan = ensureCreateHook(ws, worktree.path, dir);
  return { ...opened, ...launchAgent(ws, repo, worktree, dir, requested) };
}

export interface RemoveOptions {
  repo: string;
  branch: string;
  /** Remove a checkout with uncommitted changes, which Orca otherwise refuses. */
  force: boolean;
}

/**
 * Remove a branch's worktree the way M12 asks: run the repository's remove
 * hook inside it, park its reflection findings, and remove it through Orca
 * only when both succeeded. Parking runs the reflection journal in this
 * process, so it happens only when the clone is on this machine; a worktree
 * on a server's host is removed only once its journal is seen to hold no
 * unsent findings. The receipts of agents started in the worktree stay
 * where they are: a worktree created at its path afterwards, which Orca
 * gives the same id, is told from it by its token where an agent is started
 * (receipts.ts), and one may have been created, and its agent started,
 * before this command could look, so nothing here decides by the id.
 */
export async function removeWorkspace(
  ws: Workspace,
  options: RemoveOptions,
): Promise<string> {
  const repo = repoOf(ws, options.repo);
  const path = findGitWorktree(ws.host, repo.path, options.branch);
  if (path === null)
    throw new OrcaError(
      `no worktree of ${repo.path} has ${options.branch} checked out`,
    );
  assertLinkedWorktree(
    ws.host,
    path,
    `remove the worktree of ${options.branch}`,
  );
  const row = listedWorktree(ws, repo, path);
  if (row === null)
    throw new OrcaError(
      `${options.branch} is checked out at ${path}, which Orca${onServer(ws.target)} does not list; remove that checkout with git worktree remove`,
    );
  const steps: RemovalSteps = {
    hook: (worktree) => hookOf(ws, worktree, "remove"),
    runHook: (worktree, hook) => ws.runHook(ws.host, worktree, hook),
    park: async (worktree) => {
      if (ws.ssh === undefined) await parkJournal(ws.host, worktree);
      else assertNoUnsentFindings(ws, worktree, ws.ssh);
    },
  };
  try {
    await removeThroughOrca({
      worktree: path,
      id: row.id,
      force: options.force,
      orca: async (args) => {
        const done = ws.orca.run(orcaArgv(ws.target, args));
        return { code: done.status, stdout: done.stdout, stderr: done.stderr };
      },
      log: (line) => ws.host.log(line),
      steps,
    });
  } catch (error) {
    if (error instanceof WorktreeRemovalError)
      throw new OrcaError(error.message);
    throw error;
  }
  return path;
}

/** The workspace with every call and pause cut to what is left of `limitMs`. */
export function limitWorkspace(ws: Workspace, limitMs: number): Workspace {
  const now = Date.now;
  return {
    ...ws,
    orca: withLimit(ws.orca, limitMs, now),
    host: withLimit(ws.host, limitMs, now),
  };
}

/** A paired server and the host its clone is on; Orca on this machine when both are absent. */
export interface Target {
  environment?: string;
  ssh?: string;
}

/** `--environment` and `--ssh`, which go together: git runs where the server is. */
function parseTarget(values: { environment?: string; ssh?: string }): Target {
  if (values.environment !== undefined && values.ssh === undefined)
    throw new UsageError(
      `--environment needs --ssh, the SSH destination of the server's host, where git and the hooks run\n${USAGE}`,
    );
  if (values.ssh !== undefined && values.environment === undefined)
    throw new UsageError(`--ssh needs --environment\n${USAGE}`);
  return {
    ...(values.environment === undefined
      ? {}
      : { environment: values.environment }),
    ...(values.ssh === undefined ? {} : { ssh: values.ssh }),
  };
}

/**
 * The `open` command line for these options and target, as `parseOpen` reads
 * it back: what a caller that runs this tool as a process (the launcher's
 * Orca provider) hands it.
 */
export function openArgs(options: OpenOptions, target: Target = {}): string[] {
  const optional = (flag: string, value: string | undefined) =>
    value === undefined ? [] : [flag, value];
  return [
    "--repo",
    options.repo,
    "--branch",
    options.branch,
    ...optional("--environment", target.environment),
    ...optional("--ssh", target.ssh),
    ...optional("--reuse-prefix", options.reusePrefix),
    ...optional("--base", options.base),
    "--agent",
    options.agent,
    ...(options.noAgent ? ["--no-agent"] : []),
    ...optional("--prompt", options.prompt),
    ...optional("--key", options.key),
    ...optional("--comment", options.comment),
    ...optional("--linear-issue", options.linearIssue),
    ...(options.activate ? ["--activate"] : []),
    ...optional("--clone-url", options.clone?.url),
    ...optional("--clone-root", options.clone?.root),
    ...optional("--model", options.model),
    ...optional("--effort", options.effort),
    ...optional("--surface", options.surface),
  ];
}

/** `--model`, `--effort` and `--surface`, which shape an agent's start, so they need one. */
function parseAgentFlags(values: {
  model?: string;
  effort?: string;
  surface?: string;
  "no-agent"?: boolean;
}): Pick<OpenOptions, "model" | "effort" | "surface"> {
  const { model, effort, surface } = values;
  if (
    values["no-agent"] &&
    (model !== undefined || effort !== undefined || surface !== undefined)
  )
    throw new UsageError(
      `--model, --effort and --surface shape an agent's start; drop --no-agent\n${USAGE}`,
    );
  if (effort !== undefined && model === undefined)
    throw new UsageError(`--effort needs --model\n${USAGE}`);
  if (surface !== undefined && surface !== "chat" && surface !== "terminal")
    throw new UsageError(`--surface is chat or terminal\n${USAGE}`);
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(surface === undefined ? {} : { surface }),
  };
}

/** `--clone-url` and `--clone-root`, which go together. */
function parseCloneFlags(
  url: string | undefined,
  root: string | undefined,
): { clone?: CloneSource } {
  if (url === undefined && root === undefined) return {};
  if (url === undefined || root === undefined)
    throw new UsageError(`--clone-url and --clone-root go together\n${USAGE}`);
  return { clone: { url, root } };
}

export function parseOpen(
  args: string[],
): OpenOptions & Target & { json: boolean } {
  const { values } = strictOptions(
    {
      args,
      options: {
        repo: { type: "string" },
        branch: { type: "string" },
        environment: { type: "string" },
        ssh: { type: "string" },
        "reuse-prefix": { type: "string" },
        base: { type: "string" },
        agent: { type: "string" },
        "no-agent": { type: "boolean" },
        prompt: { type: "string" },
        key: { type: "string" },
        comment: { type: "string" },
        "linear-issue": { type: "string" },
        activate: { type: "boolean" },
        "clone-url": { type: "string" },
        "clone-root": { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        surface: { type: "string" },
        json: { type: "boolean" },
      },
    },
    USAGE,
  );
  if (!values.repo || !values.branch)
    throw new UsageError(`--repo and --branch are required\n${USAGE}`);
  if (
    values["reuse-prefix"] !== undefined &&
    !values.branch.startsWith(values["reuse-prefix"])
  )
    throw new UsageError(`--branch must start with --reuse-prefix\n${USAGE}`);
  if (values.key !== undefined && !KICKOFF_KEY.test(values.key))
    throw new UsageError(`--key must match ${KICKOFF_KEY}\n${USAGE}`);
  if (values.agent !== undefined && values.agent.trim() === "")
    throw new UsageError(`--agent needs an Orca agent id\n${USAGE}`);
  if (values.prompt !== undefined && values["no-agent"])
    throw new UsageError(`--prompt needs an agent; drop --no-agent\n${USAGE}`);
  const optional = (value: string | undefined, key: string) =>
    value === undefined ? {} : { [key]: value };
  return {
    repo: values.repo,
    branch: values.branch,
    ...parseTarget(values),
    ...optional(values["reuse-prefix"], "reusePrefix"),
    ...optional(values.base, "base"),
    agent: values.agent ?? "claude",
    noAgent: values["no-agent"] ?? false,
    ...optional(values.prompt, "prompt"),
    ...optional(values.key, "key"),
    ...optional(values.comment, "comment"),
    ...optional(values["linear-issue"], "linearIssue"),
    activate: values.activate ?? false,
    ...parseCloneFlags(values["clone-url"], values["clone-root"]),
    ...parseAgentFlags(values),
    json: values.json ?? false,
  };
}

export function parseRemove(args: string[]): RemoveOptions & Target {
  const { values } = strictOptions(
    {
      args,
      options: {
        repo: { type: "string" },
        branch: { type: "string" },
        environment: { type: "string" },
        ssh: { type: "string" },
        force: { type: "boolean" },
      },
    },
    USAGE,
  );
  if (!values.repo || !values.branch)
    throw new UsageError(`--repo and --branch are required\n${USAGE}`);
  return {
    repo: values.repo,
    branch: values.branch,
    ...parseTarget(values),
    force: values.force ?? false,
  };
}

/** The machines of a command-line run, bounded by `limitMs`. */
function build(target: Target, limitMs: number): Workspace {
  return limitWorkspace(
    workspace(
      {
        command: resolveOrcaCommand(),
        ...(target.environment === undefined
          ? {}
          : { environment: target.environment }),
      },
      target.ssh === undefined ? {} : { ssh: target.ssh },
    ),
    limitMs,
  );
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "open") {
    const values = parseOpen(rest);
    const ws = build(values, OPEN_LIMIT_MS);
    const opened = openWorkspace(ws, values);
    if (values.json) console.log(JSON.stringify(opened));
    else ws.orca.log(`✓ ${opened.path} (${opened.branch})`);
    return 0;
  }
  if (command === "remove") {
    const values = parseRemove(rest);
    await removeWorkspace(build(values, REMOVE_LIMIT_MS), values);
    return 0;
  }
  throw new UsageError(USAGE);
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));

export type { Context };
