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
 *   branch how the repository names an issue's branch, e.g.
 *          `feature/{key}-{slug}`: `{key}` is the issue key as the tracker
 *          writes it, `{slug}` the title's first words in lower case joined
 *          by hyphens; the tracker's suggestion, else the issue key in lower
 *          case, when absent
 *
 * With `{slug}` in the name, an issue whose branch was started under an
 * earlier title keeps that branch: the tool opens the one existing branch
 * that starts with the name's part before `{slug}`, and refuses when there
 * are several, unless the name it would give is one of them. Such a name
 * is refused for a key that is not a team key and a number (`ENG-12`), since
 * another issue's key could continue it.
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
import { openLimitMs, TRANSPORT_MS } from "../../herdr/limits.ts";
import { HerdrError } from "../../herdr/runner.ts";
import type { OpenRequest, Provider } from "../provider.ts";

/**
 * The tool's own limit for `open` (tools/herdr/limits.ts), which it holds
 * itself to, plus the copy and the connection around it.
 */
export const HERDR_OPEN_BUDGET_MS = openLimitMs() + TRANSPORT_MS;

const TOOL = join(import.meta.dir, "..", "..", "herdr", "workspace.ts");
const KEYS = new Set(["path", "host", "agent", "base", "branch"]);

/** How many of the title's words `{slug}` keeps. */
export const SLUG_WORDS = 4;

/**
 * The issue keys a reuse prefix is built from: a team key without hyphens,
 * a hyphen, and a number (`ENG-12`). No other such key continues one of
 * them past a character other than a digit, so the part before `{slug}`
 * starts only that issue's branches; a key the cache accepts beyond this
 * (`ENG-1-2`) would let `ENG-1`'s prefix start its branch.
 */
const REUSE_KEY = /^[A-Za-z0-9_]+-[0-9]+$/;

export interface HerdrRepo {
  path: string;
  host?: string;
  agent?: string;
  base?: string;
  branch?: string;
}

/**
 * Refuse a branch name template that cannot name one issue's branches: it
 * must hold `{key}` once and `{slug}` at most once, after `{key}` and apart
 * from it by text that does not open with a letter or digit, or the part
 * before `{slug}` would also start another issue's branch (`ENG-1` starts
 * `ENG-12`, and `ENG-12` starts `ENG-122`).
 */
export function assertBranchTemplate(template: string, where: string): void {
  const placeholders = template.match(/\{[^}]*\}/g) ?? [];
  const unknown = placeholders.filter((p) => p !== "{key}" && p !== "{slug}");
  if (unknown.length > 0)
    throw new HerdrError(
      `${where}: unknown placeholder ${unknown[0]} (known: {key}, {slug})`,
    );
  const count = (p: string) => placeholders.filter((q) => q === p).length;
  if (count("{key}") !== 1 || count("{slug}") > 1)
    throw new HerdrError(
      `${where} must hold {key} once and {slug} at most once`,
    );
  const key = template.indexOf("{key}");
  const slug = template.indexOf("{slug}");
  if (slug === -1) return;
  const after = key + "{key}".length;
  if (slug <= after)
    throw new HerdrError(
      `${where}: {slug} must come after {key}, with text between them`,
    );
  if (/^[\p{L}\p{N}]/u.test(template.slice(after)))
    throw new HerdrError(
      `${where}: the text after {key} must not open with a letter or digit, which would continue another issue's key`,
    );
}

/**
 * The title's first `SLUG_WORDS` words, in lower case, joined by hyphens.
 * A word is a run of letters, the marks combined with them, and digits, in
 * any script, after canonical composition, holding at least one letter or
 * digit: marks with nothing to combine with are not a word.
 */
export function slugOf(title: string): string {
  return title
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, SLUG_WORDS)
    .join("-");
}

export function parseRepo(settings: unknown, label: string): HerdrRepo {
  const where = `repos.${label}.herdr`;
  if (typeof settings === "string") settings = { path: settings };
  if (!isRecord(settings))
    throw new HerdrError(
      `${where} must be the clone's path or a mapping with path, host, agent, base, branch`,
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
  const branch = text("branch");
  if (branch !== undefined) assertBranchTemplate(branch, `${where}.branch`);
  return {
    path,
    ...(host === undefined ? {} : { host }),
    ...(agent === undefined ? {} : { agent }),
    ...(base === undefined ? {} : { base }),
    ...(branch === undefined ? {} : { branch }),
  };
}

export interface BranchChoice {
  branch: string;
  /** An existing branch starting with this is opened instead; see the top. */
  reusePrefix?: string;
}

/**
 * The branch to open: the repository's name for the issue, else the
 * tracker's suggestion, else the issue key.
 */
export function branchFor(
  repo: Pick<HerdrRepo, "branch">,
  request: Pick<OpenRequest, "issue" | "branch" | "title">,
): BranchChoice {
  if (repo.branch === undefined)
    return { branch: request.branch.trim() || request.issue.toLowerCase() };
  const named = repo.branch.replace("{key}", request.issue);
  const at = named.indexOf("{slug}");
  if (at === -1) return { branch: named };
  if (!REUSE_KEY.test(request.issue))
    throw new HerdrError(
      `${request.issue} is not a key of the form TEAM-123, so a branch named by ${repo.branch} could not be told from another issue's`,
    );
  const slug = slugOf(request.title);
  if (slug === "")
    throw new HerdrError(
      `${request.issue} has no title to name its branch by (${repo.branch}); open it again once the tracker can be read`,
    );
  return {
    branch: named.replace("{slug}", slug),
    reusePrefix: named.slice(0, at),
  };
}

export function openArgs(
  repo: HerdrRepo,
  request: OpenRequest,
  prompt: string,
): string[] {
  const { branch, reusePrefix } = branchFor(repo, request);
  return [
    "open",
    "--repo",
    repo.path,
    "--branch",
    branch,
    ...(reusePrefix === undefined ? [] : ["--reuse-prefix", reusePrefix]),
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
    const read = spawn([shell, "-l", "-c", 'printf "\\n%s" "$PATH"'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      env,
    });
    // A profile may print to stdout first; the PATH is the last line.
    const path = read.stdout.toString().split("\n").at(-1)?.trim() ?? "";
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
        // Only this launch's file is copied: after a failed write, what is on
        // disk is missing or an earlier launch's, and may be out of date.
        if (
          request.cacheWriteFailed ||
          !(await Bun.file(request.cacheFile).exists())
        )
          throw new HerdrError(
            `${request.issue}'s context cache ${request.cacheFile} was not written by this launch (see the warning above), so there is nothing current to copy to ${repo.host}; fix that and open the issue again`,
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
