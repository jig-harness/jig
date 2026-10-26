/**
 * The Orca provider: open the issue as an Orca worktree, in Orca on this
 * machine or on a paired Orca server, and hand the agent's start to the
 * person, or start the agent the settings name.
 *
 * The work is the Orca workspace tool's `open` (tools/orca/README.md): it
 * creates the issue's branch as a worktree through Orca, or reattaches to the
 * checkout that has it, names the branch as the repository does, runs the
 * repository's create hook once, and starts the agent with the prompt once
 * per issue, so opening the same issue again neither duplicates the worktree
 * nor prompts a working agent twice.
 *
 * Without an `agent` setting nothing is started: the issue carries nothing
 * that picks an agent, a model or an effort, so the person does. The create
 * hook then runs in the worktree's `setup` tab, the first prompt goes onto
 * this machine's clipboard and into the worktree's Orca comment (which any
 * device shows), and the worktree is revealed in Orca, where the person opens
 * an agent tab and pastes the prompt. On a server, Orca's tool runs here and
 * reaches the server, git and the hooks run on the server's host over SSH,
 * and the issue's cache file is copied to the same place under the host
 * user's home first; the prompt names that copy.
 *
 * The tool runs as a process of its own, as the Herdr provider runs its tool:
 * its steps are synchronous calls, which in this process would hold the
 * event loop and with it the launcher's deadline, so a child is what the
 * deadline can end.
 *
 * Settings per repository (`repos.<label>.orca`):
 *   repo         the repository's name in Orca (`orca repo list`), on the
 *                machine Orca runs on
 *   environment  a paired Orca server by name (`orca environment list`);
 *                Orca on this machine when absent
 *   ssh          the SSH destination of the server's host, where git and the
 *                hooks run; the environment's name when absent
 *   agent        the Orca agent id to start (`claude`, `codex`); none when
 *                absent, and the person starts one
 *   model        the agent's model; its default when absent (needs agent)
 *   effort       the model's reasoning effort (needs model)
 *   surface      `chat` or `terminal`; Orca's Chat UI setting when absent
 *   base         what a new branch is cut from; the clone's `origin/HEAD`
 *                when absent
 *   branch, slug how the repository names an issue's branch, as for the
 *                Herdr provider (providers/herdr.ts)
 *   clone        `{url, root}`: when Orca has no such repository, clone
 *                `url` (its `{repo}` read as `repo`) into `<root>/<repo>`
 *                where the clone goes, and add it to Orca (tools/orca/clone.ts)
 *
 * An issue that is not routed to a repository is refused: Orca has several
 * repositories and nothing in the issue picks one.
 */
import { join } from "node:path";
import { isRecord } from "../../../lib/record.ts";
import { TRANSPORT_MS } from "../../herdr/limits.ts";
import { assertHost } from "../../herdr/remote.ts";
import { HerdrError } from "../../herdr/runner.ts";
import { assertCloneUrl, type CloneSource } from "../../orca/clone.ts";
import { OrcaError } from "../../orca/runner.ts";
import {
  OPEN_LIMIT_MS,
  type Opened,
  type OpenOptions,
  openArgs,
} from "../../orca/workspace.ts";
import { copyCacheOverSsh } from "../cache-copy.ts";
import { copyToClipboard } from "../clipboard.ts";
import type { OpenRequest, Provider } from "../provider.ts";
import {
  branchFor,
  loginShellPath,
  parseBranchNaming,
  repoMapping,
  type SettingText,
  settingText,
  type SlugKind,
} from "./herdr.ts";

/** The tool's own limit for `open`, which it holds itself to, plus the copy and the connection around it. */
export const ORCA_OPEN_BUDGET_MS = OPEN_LIMIT_MS + TRANSPORT_MS;

const TOOL = join(import.meta.dir, "..", "..", "orca", "workspace.ts");

const KEYS = new Set([
  "repo",
  "environment",
  "ssh",
  "agent",
  "base",
  "branch",
  "slug",
  "clone",
  "model",
  "effort",
  "surface",
]);

export interface OrcaRepo {
  repo: string;
  environment?: string;
  ssh?: string;
  agent?: string;
  base?: string;
  branch?: string;
  slug?: SlugKind;
  clone?: CloneSource;
  model?: string;
  effort?: string;
  surface?: "chat" | "terminal";
}

/** `model`, `effort` and `surface`, which shape the start of an agent `agent` names. */
function parseAgentStart(
  text: SettingText,
  agent: string | undefined,
  where: string,
): Pick<OrcaRepo, "model" | "effort" | "surface"> {
  const model = text("model");
  const effort = text("effort");
  const surface = text("surface");
  for (const [key, value] of [
    ["model", model],
    ["effort", effort],
    ["surface", surface],
  ] as const)
    if (value !== undefined && agent === undefined)
      throw new HerdrError(
        `${where}.${key} shapes the start of an agent, so it needs ${where}.agent`,
      );
  if (effort !== undefined && model === undefined)
    throw new HerdrError(`${where}.effort needs ${where}.model`);
  if (surface !== undefined && surface !== "chat" && surface !== "terminal")
    throw new HerdrError(`${where}.surface is chat or terminal`);
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(surface === undefined ? {} : { surface }),
  };
}

/** `clone` as a mapping of `url` and `root` and nothing else. */
function cloneMapping(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new HerdrError(`${at} must be a mapping of url and root`);
  for (const key of Object.keys(value))
    if (key !== "url" && key !== "root")
      throw new HerdrError(`${at}: unknown key ${key} (known: url, root)`);
  return value;
}

/** `clone`: a mapping of `url` and `root`, both text, `{repo}` in the URL filled in. */
function parseClone(
  value: unknown,
  repo: string,
  where: string,
): CloneSource | undefined {
  if (value === undefined) return undefined;
  const at = `${where}.clone`;
  const text = settingText(cloneMapping(value, at), at);
  const url = text("url");
  const root = text("root");
  if (url === undefined || root === undefined)
    throw new HerdrError(`${at} needs both url and root`);
  if (!root.startsWith("/") && root !== "~" && !root.startsWith("~/"))
    throw new HerdrError(`${at}.root must be absolute or start with ~/`);
  const source = url.replaceAll("{repo}", () => repo);
  try {
    assertCloneUrl(source);
  } catch (error) {
    throw new HerdrError(
      `${at}.url: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { url: source, root };
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
  const mapping = repoMapping(
    settings,
    where,
    KEYS,
    "repo",
    "the repository's name in Orca",
  );
  const text = settingText(mapping, where);
  const repo = text("repo");
  if (repo === undefined) throw new HerdrError(`${where}.repo is required`);
  const agent = text("agent");
  const base = text("base");
  const clone = parseClone(mapping.clone, repo, where);
  return {
    repo,
    ...(clone === undefined ? {} : { clone }),
    ...parseServer(text, where),
    ...(agent === undefined ? {} : { agent }),
    ...parseAgentStart(text, agent, where),
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
  const heading =
    request.title === "" ? request.issue : `${request.issue}: ${request.title}`;
  const common = {
    repo: repo.repo,
    branch,
    ...(reusePrefix === undefined ? {} : { reusePrefix }),
    ...(repo.base === undefined ? {} : { base: repo.base }),
    linearIssue: request.issue,
    activate: true,
    ...(repo.clone === undefined ? {} : { clone: repo.clone }),
  };
  // No agent named: the person starts one, so the comment carries the
  // prompt for them to copy on whichever device they open the worktree.
  if (repo.agent === undefined)
    return {
      ...common,
      agent: "claude",
      noAgent: true,
      comment: `${heading}\n\n${prompt}`,
    };
  return {
    ...common,
    agent: repo.agent,
    ...(repo.model === undefined ? {} : { model: repo.model }),
    ...(repo.effort === undefined ? {} : { effort: repo.effort }),
    ...(repo.surface === undefined ? {} : { surface: repo.surface }),
    noAgent: false,
    prompt,
    key: request.issue,
    comment: heading,
  };
}

export interface OrcaDeps {
  /** Copy the cache file to the host; returns its path there. */
  copyCache: (
    host: string,
    file: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Put the prompt on this machine's clipboard; the command that took it, or null. */
  copy: (text: string) => Promise<string | null>;
  /** Run the workspace tool's `open` for the repository; ends it when `signal` aborts. */
  open: (
    repo: OrcaRepo,
    options: OpenOptions,
    signal: AbortSignal,
  ) => Promise<Opened>;
}

const KICKOFFS = new Set(["sent", "already-sent", "none"]);

/** What the tool printed with `--json`, read back as what it opened; anything else is an error, never a result. */
export function parseOpened(text: string): Opened {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    parsed = null;
  }
  const filled = (value: unknown): value is string =>
    typeof value === "string" && value !== "";
  if (
    !isRecord(parsed) ||
    !filled(parsed.path) ||
    !filled(parsed.branch) ||
    !filled(parsed.worktreeId) ||
    typeof parsed.reattached !== "boolean" ||
    typeof parsed.hookRan !== "boolean" ||
    typeof parsed.agentLaunched !== "boolean" ||
    typeof parsed.kickoff !== "string" ||
    !KICKOFFS.has(parsed.kickoff)
  )
    throw new OrcaError(
      `the Orca workspace tool answered with something other than what it opened: ${text.trim() || "nothing"}`,
    );
  return parsed as unknown as Opened;
}

/**
 * Open through Orca's tool as a process of its own, with the login shell's
 * `PATH`: the tracker starts the launcher without the shell profile, so `git`
 * and Orca's command installed where only the profile adds them are found.
 * The tool's progress goes to this process's stderr as it arrives; its
 * `--json` answer is read back. An abort ends the child.
 */
async function openHere(
  repo: OrcaRepo,
  options: OpenOptions,
  signal: AbortSignal,
): Promise<Opened> {
  const path = loginShellPath();
  const target = {
    ...(repo.environment === undefined
      ? {}
      : { environment: repo.environment }),
    ...(repo.ssh === undefined ? {} : { ssh: repo.ssh }),
  };
  const proc = Bun.spawn(
    [process.execPath, TOOL, "open", ...openArgs(options, target), "--json"],
    {
      env: { ...process.env, ...(path === undefined ? {} : { PATH: path }) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal,
    },
  );
  const decoder = new TextDecoder();
  const relayed = (async () => {
    for await (const chunk of proc.stderr)
      process.stderr.write(decoder.decode(chunk, { stream: true }));
  })();
  const [status, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    relayed,
  ]);
  if (signal.aborted)
    throw new OrcaError(
      "the Orca workspace tool did not finish before the launcher's deadline and was ended",
    );
  if (status !== 0)
    throw new OrcaError(
      `the Orca workspace tool failed (exit ${status}); its output is above`,
    );
  return parseOpened(stdout);
}

const defaultDeps: OrcaDeps = {
  copyCache: copyCacheOverSsh,
  copy: (text) => copyToClipboard(text),
  open: openHere,
};

/** What the launch says it did, after the worktree's path and branch. */
async function outcome(
  repo: OrcaRepo,
  opened: Opened,
  prompt: string,
  copy: OrcaDeps["copy"],
): Promise<string> {
  if (repo.agent !== undefined)
    return opened.agentLaunched
      ? `; ${repo.agent} started`
      : opened.kickoff === "already-sent"
        ? "; its agent was already started"
        : "";
  const setup = opened.setupInTab ? '; setup runs in its "setup" tab' : "";
  const copied = await copy(prompt);
  return `${setup}; no agent started: open an agent tab in Orca and paste the prompt, which is ${copied === null ? "below" : "on the clipboard"} and in the worktree's comment${copied === null ? `:\n${prompt}` : ""}`;
}

export function orcaProvider(deps: Partial<OrcaDeps> = {}): Provider {
  const { copyCache, copy, open } = { ...defaultDeps, ...deps };
  return {
    name: "orca",
    openBudgetMs: ORCA_OPEN_BUDGET_MS,
    validateRepo(settings, label) {
      parseRepo(settings, label);
    },
    async open(request) {
      if (request.repo === null)
        throw new OrcaError(
          `${request.issue} is not routed to a repository; give it a repository label, with a repos.<label>.orca entry or defaults.orca in the launcher configuration`,
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
      const opened = await open(
        repo,
        openOptions(repo, request, prompt),
        request.signal,
      );
      console.error(
        `[launcher] ${request.issue}: ${opened.reattached ? "reattached to" : "opened"} ${opened.path} (${opened.branch})${await outcome(repo, opened, prompt, copy)}`,
      );
    },
  };
}
