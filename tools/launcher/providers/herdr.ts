/**
 * The Herdr provider: open the issue as a Herdr worktree workspace, with the
 * agent started and given the prompt, on this machine or on a host over SSH.
 *
 * The work is the Herdr workspace tool's `open` (tools/herdr/README.md): it
 * creates the issue's branch as a worktree, or reattaches to the one that
 * has it, waits for the repository's create hook, starts the agent and sends
 * the prompt once per issue, keyed by the issue key, so opening the same
 * issue again neither duplicates the worktree nor prompts a working agent
 * twice. On a host, the tool runs there, since the clone and the Herdr server
 * are there, and the issue's cache file is copied to the same place under
 * the host user's home first; the prompt names that copy.
 *
 * Settings per repository (`repos.<label>.herdr`):
 *   path   the clone on the machine that runs Herdr (`~/` allowed)
 *   host   the SSH destination of that machine; this machine when absent
 *   agent  the Herdr agent kind to start; `claude` when absent
 *   base   what a new branch is cut from; the clone's `origin/HEAD` when absent
 *
 * An issue that is not routed to a repository is refused: unlike Conductor,
 * Herdr has no repository list to choose from. On this machine the tool runs
 * with the login shell's `PATH`, which finds a `git` or `herdr` the tracker's
 * own environment does not.
 */
import { join, relative } from "node:path";
import { isRecord } from "../../../lib/record.ts";
import {
  assertHost,
  runToolOnHost,
  shellQuote,
  ssh,
} from "../../herdr/remote.ts";
import { openLimitMs } from "../../herdr/limits.ts";
import { HerdrError } from "../../herdr/runner.ts";
import type { OpenRequest, Provider } from "../provider.ts";

/** Copying the cache file and starting the SSH session, around the tool's run. */
const TRANSPORT_MS = 2 * 60_000;

/**
 * The tool's own limit for `open` (tools/herdr/limits.ts), so every run it
 * allows fits, plus the copy and the connection around it.
 */
export const HERDR_OPEN_BUDGET_MS = openLimitMs() + TRANSPORT_MS;

const TOOL = join(import.meta.dir, "..", "..", "herdr", "workspace.ts");
const KEYS = new Set(["path", "host", "agent", "base"]);

export interface HerdrRepo {
  path: string;
  host?: string;
  agent?: string;
  base?: string;
}

export function parseRepo(settings: unknown, label: string): HerdrRepo {
  const where = `repos.${label}.herdr`;
  if (typeof settings === "string") settings = { path: settings };
  if (!isRecord(settings))
    throw new HerdrError(
      `${where} must be the clone's path or a mapping with path, host, agent, base`,
    );
  for (const key of Object.keys(settings))
    if (!KEYS.has(key))
      throw new HerdrError(
        `${where}: unknown key ${key} (known: ${[...KEYS].join(", ")})`,
      );
  const text = (key: string): string | undefined => {
    const value = settings[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "")
      throw new HerdrError(`${where}.${key} must be a non-empty string`);
    return value.trim();
  };
  const path = text("path");
  if (path === undefined) throw new HerdrError(`${where}.path is required`);
  const host = text("host");
  if (host !== undefined) assertHost(host);
  const agent = text("agent");
  const base = text("base");
  return {
    path,
    ...(host === undefined ? {} : { host }),
    ...(agent === undefined ? {} : { agent }),
    ...(base === undefined ? {} : { base }),
  };
}

/** The branch to open: the tracker's suggestion, else the issue key. */
export function branchFor(
  request: Pick<OpenRequest, "issue" | "branch">,
): string {
  return request.branch.trim() || request.issue.toLowerCase();
}

export function openArgs(
  repo: HerdrRepo,
  request: OpenRequest,
  prompt: string,
): string[] {
  return [
    "open",
    "--repo",
    repo.path,
    "--branch",
    branchFor(request),
    "--label",
    request.issue,
    "--agent",
    repo.agent ?? "claude",
    ...(repo.base === undefined ? [] : ["--base", repo.base]),
    "--prompt",
    prompt,
    "--key",
    request.issue,
  ];
}

export interface HerdrDeps {
  /** Copy the cache file to the host; returns its path there. */
  copyCache: (
    host: string,
    file: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Run the workspace tool; resolves with its exit status and error output. */
  runTool: (
    host: string | undefined,
    args: string[],
    signal: AbortSignal,
  ) => Promise<{ status: number; stderr: string }>;
}

/**
 * Write the cache file to the same path under the host user's home, whole
 * and private, and return where it went.
 */
async function copyCacheOverSsh(
  host: string,
  file: string,
  signal: AbortSignal,
): Promise<string> {
  const home = process.env.HOME ?? "";
  const rel = relative(home, file);
  if (home === "" || rel.startsWith(".."))
    throw new HerdrError(`the cache file ${file} is not under ${home}`);
  const target = `"$HOME"/${shellQuote(rel)}`;
  const command = [
    "umask 077",
    `mkdir -p "$(dirname ${target})"`,
    `cat > ${target}.tmp.$$`,
    `mv ${target}.tmp.$$ ${target}`,
    `printf %s ${target}`,
  ].join(" && ");
  const content = await Bun.file(file).text();
  const done = await ssh(host, command, content, signal);
  if (done.status !== 0)
    throw new HerdrError(
      `could not copy ${file} to ${host}: ${done.stderr.trim()}`,
    );
  return done.stdout.trim();
}

/**
 * The `PATH` of the user's login shell, else this process's own. The tracker
 * starts the launcher without the shell profile, so `git` and `herdr`
 * installed in a user or package-manager directory are on the login shell's
 * `PATH` and not on the inherited one.
 */
export function loginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): string | undefined {
  const shell = env.SHELL;
  if (shell === undefined || !shell.startsWith("/")) return env.PATH;
  try {
    const read = spawn([shell, "-l", "-c", 'printf %s "$PATH"'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      env,
    });
    const path = read.stdout.toString().trim();
    return read.exitCode === 0 && path !== "" ? path : env.PATH;
  } catch {
    return env.PATH;
  }
}

async function runToolHere(
  args: string[],
  signal: AbortSignal,
): Promise<{ status: number; stderr: string }> {
  const path = loginShellPath();
  const proc = Bun.spawn([process.execPath, TOOL, ...args], {
    env: { ...process.env, ...(path === undefined ? {} : { PATH: path }) },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    signal,
  });
  const decoder = new TextDecoder();
  let stderr = "";
  for await (const chunk of proc.stderr) {
    const text = decoder.decode(chunk, { stream: true });
    stderr += text;
    process.stderr.write(text);
  }
  return { status: await proc.exited, stderr };
}

const defaultDeps: HerdrDeps = {
  copyCache: copyCacheOverSsh,
  runTool: async (host, args, signal) =>
    host === undefined
      ? runToolHere(args, signal)
      : runToolOnHost(host, args, signal, (chunk) =>
          process.stderr.write(chunk),
        ),
};

export function herdrProvider(deps: Partial<HerdrDeps> = {}): Provider {
  const { copyCache, runTool } = { ...defaultDeps, ...deps };
  return {
    name: "herdr",
    openBudgetMs: HERDR_OPEN_BUDGET_MS,
    validateRepo(settings, label) {
      parseRepo(settings, label);
    },
    async open(request) {
      if (request.repo === null)
        throw new HerdrError(
          `${request.issue} is not routed to a repository; give it a repository label with a repos.<label>.herdr entry in the launcher configuration`,
        );
      const repo = parseRepo(request.repo, "<label>");
      let prompt = request.prompt;
      if (repo.host !== undefined) {
        // The prompt names the cache file, which the agent on the host must
        // be able to read; a path on this machine would name nothing there.
        if (!(await Bun.file(request.cacheFile).exists()))
          throw new HerdrError(
            `${request.issue}'s context cache ${request.cacheFile} was not written (see the warning above), so there is nothing to copy to ${repo.host}; fix that and open the issue again`,
          );
        prompt = request.promptFor(
          await copyCache(repo.host, request.cacheFile, request.signal),
        );
      }
      const done = await runTool(
        repo.host,
        openArgs(repo, request, prompt),
        request.signal,
      );
      if (done.status !== 0)
        throw new HerdrError(
          `the Herdr workspace tool failed (exit ${done.status})${repo.host === undefined ? "" : ` on ${repo.host}`}; its output is above`,
        );
    },
  };
}
