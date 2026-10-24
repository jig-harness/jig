/**
 * The Orca provider: open the issue as an Orca worktree, with the agent
 * started and given the prompt, in Orca on this machine or on a paired Orca
 * server.
 *
 * The work is the Orca workspace tool's `open` (tools/orca/README.md): it
 * creates the issue's branch as a worktree through Orca, or reattaches to the
 * checkout that has it, names the branch as the repository does, runs the
 * repository's create hook once, and starts the agent with the prompt once
 * per issue, so opening the same issue again neither duplicates the worktree
 * nor prompts a working agent twice. On a server, Orca's tool runs here and
 * reaches the server, git and the hooks run on the server's host over SSH,
 * and the issue's cache file is copied to the same place under the host
 * user's home first; the prompt names that copy.
 *
 * Settings per repository (`repos.<label>.orca`):
 *   repo         the repository's name in Orca (`orca repo list`), on the
 *                machine Orca runs on
 *   environment  a paired Orca server by name (`orca environment list`);
 *                Orca on this machine when absent
 *   ssh          the SSH destination of the server's host, where git and the
 *                hooks run; the environment's name when absent
 *   agent        the Orca agent id to start; `claude` when absent
 *   base         what a new branch is cut from; the clone's `origin/HEAD`
 *                when absent
 *   branch, slug how the repository names an issue's branch, as for the
 *                Herdr provider (providers/herdr.ts)
 *
 * An issue that is not routed to a repository is refused: Orca has several
 * repositories and nothing in the issue picks one.
 */
import { isRecord } from "../../../lib/record.ts";
import { TRANSPORT_MS } from "../../herdr/limits.ts";
import { assertHost } from "../../herdr/remote.ts";
import { HerdrError } from "../../herdr/runner.ts";
import { resolveOrcaCommand } from "../../orca/cli.ts";
import { OrcaError, workspace } from "../../orca/runner.ts";
import {
  limitWorkspace,
  OPEN_LIMIT_MS,
  type Opened,
  type OpenOptions,
  openWorkspace,
} from "../../orca/workspace.ts";
import { copyCacheOverSsh } from "../cache-copy.ts";
import type { OpenRequest, Provider } from "../provider.ts";
import {
  branchFor,
  loginShellPath,
  parseBranchNaming,
  type SettingText,
  settingText,
  type SlugKind,
} from "./herdr.ts";

/** The tool's own limit for `open`, which it holds itself to, plus the copy and the connection around it. */
export const ORCA_OPEN_BUDGET_MS = OPEN_LIMIT_MS + TRANSPORT_MS;

const KEYS = new Set([
  "repo",
  "environment",
  "ssh",
  "agent",
  "base",
  "branch",
  "slug",
]);

export interface OrcaRepo {
  repo: string;
  environment?: string;
  ssh?: string;
  agent?: string;
  base?: string;
  branch?: string;
  slug?: SlugKind;
}

/** `environment` and `ssh`: the server, and the host git runs on for it. */
function parseServer(
  text: SettingText,
  where: string,
): Pick<OrcaRepo, "environment" | "ssh"> {
  const environment = text("environment");
  const given = text("ssh");
  if (given !== undefined && environment === undefined)
    throw new HerdrError(
      `${where}.ssh names where git runs for a server, so it needs ${where}.environment`,
    );
  if (environment === undefined) return {};
  const ssh = given ?? environment;
  try {
    assertHost(ssh);
  } catch (error) {
    throw new HerdrError(
      `${where}.${given === undefined ? "environment" : "ssh"}: ${error instanceof Error ? error.message : String(error)}; set ${where}.ssh to the SSH destination of the server's host`,
    );
  }
  return { environment, ssh };
}

export function parseRepo(settings: unknown, label: string): OrcaRepo {
  const where = `repos.${label}.orca`;
  if (typeof settings === "string") settings = { repo: settings };
  if (!isRecord(settings))
    throw new HerdrError(
      `${where} must be the repository's name in Orca or a mapping with ${[...KEYS].join(", ")}`,
    );
  for (const key of Object.keys(settings))
    if (!KEYS.has(key))
      throw new HerdrError(
        `${where}: unknown key ${key} (known: ${[...KEYS].join(", ")})`,
      );
  const text = settingText(settings, where);
  const repo = text("repo");
  if (repo === undefined) throw new HerdrError(`${where}.repo is required`);
  const agent = text("agent");
  const base = text("base");
  return {
    repo,
    ...parseServer(text, where),
    ...(agent === undefined ? {} : { agent }),
    ...(base === undefined ? {} : { base }),
    ...parseBranchNaming(text, where),
  };
}

/** The tool's options for a request, once the prompt names a file the agent can read. */
export function openOptions(
  repo: OrcaRepo,
  request: OpenRequest,
  prompt: string,
): OpenOptions {
  const { branch, reusePrefix } = branchFor(repo, request);
  return {
    repo: repo.repo,
    branch,
    ...(reusePrefix === undefined ? {} : { reusePrefix }),
    ...(repo.base === undefined ? {} : { base: repo.base }),
    agent: repo.agent ?? "claude",
    noAgent: false,
    prompt,
    key: request.issue,
    comment:
      request.title === ""
        ? request.issue
        : `${request.issue}: ${request.title}`,
    linearIssue: request.issue,
    activate: true,
  };
}

export interface OrcaDeps {
  /** Copy the cache file to the host; returns its path there. */
  copyCache: (
    host: string,
    file: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Run the workspace tool's `open` for the repository. */
  open: (repo: OrcaRepo, options: OpenOptions) => Opened;
}

/**
 * Open through Orca's tool on this machine, with the login shell's `PATH`:
 * the tracker starts the launcher without the shell profile, so `git` and
 * Orca's command installed where only the profile adds them are found.
 */
function openHere(repo: OrcaRepo, options: OpenOptions): Opened {
  const path = loginShellPath();
  const env = { ...process.env, ...(path === undefined ? {} : { PATH: path }) };
  const ws = limitWorkspace(
    workspace(
      {
        command: resolveOrcaCommand(env),
        ...(repo.environment === undefined
          ? {}
          : { environment: repo.environment }),
      },
      { env, ...(repo.ssh === undefined ? {} : { ssh: repo.ssh }) },
    ),
    OPEN_LIMIT_MS,
  );
  return openWorkspace(ws, options);
}

const defaultDeps: OrcaDeps = {
  copyCache: copyCacheOverSsh,
  open: openHere,
};

export function orcaProvider(deps: Partial<OrcaDeps> = {}): Provider {
  const { copyCache, open } = { ...defaultDeps, ...deps };
  return {
    name: "orca",
    openBudgetMs: ORCA_OPEN_BUDGET_MS,
    validateRepo(settings, label) {
      parseRepo(settings, label);
    },
    async open(request) {
      if (request.repo === null)
        throw new OrcaError(
          `${request.issue} is not routed to a repository; give it a repository label with a repos.<label>.orca entry in the launcher configuration`,
        );
      const repo = parseRepo(request.repo, "<label>");
      let prompt = request.prompt;
      if (repo.ssh !== undefined) {
        // The prompt names the cache file, which the agent on the server's
        // host must be able to read; a path on this machine would name
        // nothing there. Only this launch's file is copied: after a failed
        // write, what is on disk is missing or an earlier launch's.
        if (
          request.cacheWriteFailed ||
          !(await Bun.file(request.cacheFile).exists())
        )
          throw new OrcaError(
            `${request.issue}'s context cache ${request.cacheFile} was not written by this launch (see the warning above), so there is nothing current to copy to ${repo.ssh}; fix that and open the issue again`,
          );
        prompt = request.promptFor(
          await copyCache(repo.ssh, request.cacheFile, request.signal),
        );
      }
      const opened = open(repo, openOptions(repo, request, prompt));
      console.error(
        `[launcher] ${request.issue}: ${opened.reattached ? "reattached to" : "opened"} ${opened.path} (${opened.branch})${opened.agentLaunched ? `; ${repo.agent ?? "claude"} started` : opened.kickoff === "already-sent" ? "; its agent was already started" : ""}`,
      );
    },
  };
}
