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
 * Herdr has no repository list to choose from.
 */
import { join, relative } from "node:path";
import { isRecord } from "../../../lib/record.ts";
import {
  assertHost,
  runToolOnHost,
  shellQuote,
  ssh,
} from "../../herdr/remote.ts";
import { HerdrError } from "../../herdr/runner.ts";
import type { OpenRequest, Provider } from "../provider.ts";

/** Setup hooks, the agent's start and the kickoff all fit in it. */
export const HERDR_OPEN_BUDGET_MS = 20 * 60_000;

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

async function runToolHere(
  args: string[],
  signal: AbortSignal,
): Promise<{ status: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TOOL, ...args], {
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
      if (
        repo.host !== undefined &&
        (await Bun.file(request.cacheFile).exists())
      )
        prompt = request.promptFor(
          await copyCache(repo.host, request.cacheFile, request.signal),
        );
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
