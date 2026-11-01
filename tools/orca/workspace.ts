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
  COMMAND_ALLOWANCE,
  HOOK_TIMEOUT_MS,
  HOOKS_DIR,
  OPEN_LIMIT_MS,
} from "../../plugin/shared/orca-workspace/limits.ts";
import {
  attachBranch,
  chooseBranch,
  listedWorktree,
  type OrcaRepo,
  type OrcaWorktree,
  repoOf,
  setWorktree,
} from "../../plugin/shared/orca-workspace/open.ts";
import {
  assertBranchName,
  assertLinkedWorktree,
  findGitWorktree,
} from "../herdr/git.ts";
import { KICKOFF_KEY } from "../herdr/kickoff.ts";
import { PARK_TIMEOUT_MS, parkJournal } from "../herdr/lifecycle.ts";
import { UsageError } from "../herdr/options.ts";
import { ownerLine } from "../herdr/owner.ts";
import {
  COMMAND_TIMEOUT_MS,
  type Context,
  withLimit,
} from "../herdr/runner.ts";
import {
  onServer,
  orcaCall,
  orcaErrorText,
  portOf,
  resolveOrcaCommand,
} from "./cli.ts";
import { type CloneSource, cloneMissingRepo } from "./clone.ts";
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

export { OPEN_LIMIT_MS };
export { CREATE_HOOK_CLAIM, CREATE_HOOK_MARK } from "./hooks.ts";
export { fileSegment, type Receipt, receiptPath } from "./receipts.ts";

export const USAGE = `usage:
  workspace.ts open --repo <name> --branch <name> [--environment <name> --ssh <host>] [--reuse-prefix <text>]
      [--base <ref>] [--agent <id>] [--no-agent] [--prompt <text>] [--key <key>] [--comment <text>]
      [--linear-issue <key>] [--activate] [--clone-url <url> --clone-root <dir>]
      [--model <id> [--effort <level>]] [--surface chat|terminal] [--json]
  workspace.ts remove --repo <name> --branch <name> [--environment <name> --ssh <host>] [--force]`;

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

/** The repository Orca knows by `name`; with `clone`, one Orca does not have is cloned and added first. */
function repoNamed(ws: Workspace, name: string, clone?: CloneSource): OrcaRepo {
  return repoOf(
    portOf(ws),
    name,
    clone === undefined
      ? undefined
      : (missing) => cloneMissingRepo(ws, missing, clone),
  );
}

/** Link the issue in Orca's Linear integration; a failure only warns, since the link is a convenience. */
function linkIssue(ws: Workspace, worktree: OrcaWorktree, issue: string): void {
  const reason = setWorktree(portOf(ws), worktree, "--linear-issue", issue);
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
  const reason = setWorktree(portOf(ws), worktree, "--comment", comment);
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
  const repo = repoNamed(ws, requested.repo, requested.clone);
  const port = portOf(ws);
  const branch = chooseBranch(
    port,
    repo.path,
    requested.branch,
    requested.reusePrefix,
  );
  if (branch !== requested.branch) assertBranchName(ws.host, branch);
  const { worktree, reattached } = attachBranch(port, repo, branch, {
    ...(requested.base === undefined ? {} : { base: requested.base }),
    ...(requested.comment === undefined ? {} : { comment: requested.comment }),
    createFlags: requested.activate ? ["--activate"] : [],
  });
  // On every path, reattaching included: a link that failed in an earlier
  // open (the integration not yet connected) is tried again.
  if (requested.linearIssue !== undefined)
    linkIssue(ws, worktree, requested.linearIssue);
  if (reattached && requested.noAgent && requested.comment !== undefined)
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
    reattached,
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
  const repo = repoNamed(ws, options.repo);
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
  const row = listedWorktree(portOf(ws), repo, path);
  if (row === null)
    throw new OrcaError(
      `${options.branch} is checked out at ${path}, which Orca${onServer(ws.target)} does not list; remove that checkout with git worktree remove`,
    );
  const hook = hookOf(ws, path, "remove");
  if (hook !== null) {
    ws.host.log(`… running ${HOOKS_DIR}/remove`);
    ws.runHook(ws.host, path, hook);
  }
  if (ws.ssh === undefined) await parkJournal(ws.host, path);
  else assertNoUnsentFindings(ws, path, ws.ssh);
  const what = "orca worktree rm";
  const envelope = orcaCall(
    ws,
    [
      "worktree",
      "rm",
      "--worktree",
      `id:${row.id}`,
      ...(options.force ? ["--force"] : []),
    ],
    what,
  );
  if (!envelope.ok)
    throw new OrcaError(
      `${what}: ${orcaErrorText(envelope.error)}${options.force ? "" : " (uncommitted changes: commit them, or pass --force to discard them)"}`,
    );
  ws.host.log(`✓ removed ${path}`);
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
