/**
 * The repository a run of `gh` addresses, which the client's stored login
 * may pick its account by.
 *
 * A machine that works for several GitHub accounts often lets the client
 * choose the account per repository: a `gh` wrapper that, with no token in
 * the environment, picks one of the stored logins from the repository the
 * command addresses. One stored login then spends a different account's
 * allowance in each repository, so its quota owner (`github-owner.ts`) is
 * asked and kept per repository: the repository a run addresses is the
 * run's scope, `owner/repo` lowercased, read in this order:
 *
 * 1. the `-R`/`--repo` value (`-R x`, `-Rx`, `-R=x`, `--repo x`,
 *    `--repo=x`); a `HOST/OWNER/REPO` or URL value gives its last two path
 *    segments; failing that, a positional `https://HOST/OWNER/REPO/…`
 *    argument;
 * 2. for `gh api`, a route that starts `repos/<owner>/<repo>`;
 * 3. `GH_REPO` in the run's environment;
 * 4. the remote `gh repo set-default` chose, else the `origin` remote, of
 *    the run's working directory, read by local `git config` runs (no
 *    network, a 2-second deadline each) and kept for 30 seconds. A remote in https, `ssh://` or `user@host:owner/repo`
 *    form gives its last two path segments, whatever its host, since an SSH
 *    host alias is a common way to pick an account; a local path gives none.
 *
 * A run that addresses no repository has no scope, and neither has a run
 * with a token in the environment: a token names its own user whatever the
 * repository.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { credentialKey } from "./budget.ts";
import { apiRoute, VALUED } from "./gh-route.ts";
import { githubToken } from "./github-credential.ts";
import { gitIdentityEnv } from "../git-env.ts";
import { swallow } from "../errors.ts";
import { currentMs } from "../time.ts";

type Env = Record<string, string | undefined>;

/** How long the local `git config` read of a directory's remote may take. */
const ORIGIN_DEADLINE_MS = 2_000;

/**
 * Flags of the common subcommands whose value is free text, never a flag.
 * A short alias that is valued in one subcommand and a switch in another
 * (`-a`, `-m`, `-p`, `-r`) is left out: skipping its next word would hide a
 * `-R` after a switch, while reading it as a switch only misreads a value
 * that is itself a repository flag.
 */
const TEXT_VALUED = new Set([
  "-b",
  "-l",
  "--label",
  "--assignee",
  "-F",
  "--body-file",
  "-t",
  "--template",
  "-M",
  "--milestone",
  "-B",
  "--base",
  "-H",
  "--head",
  "--reviewer",
  "--project",
  "--body",
  "--title",
  "--message",
  "--subject",
  "--search",
  "-S",
]);

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** `owner/repo`, lowercased, from the last two path segments of `path`; `null` when they do not read as one. */
function lastTwo(path: string): string | null {
  const parts = path
    .replace(/[?#].*$/, "")
    .split("/")
    .filter((p) => p !== "");
  const owner = parts.at(-2);
  const repo = parts.at(-1)?.replace(/\.git$/i, "");
  if (owner === undefined || repo === undefined || repo === "") return null;
  return SEGMENT.test(owner) && SEGMENT.test(repo) && !/^\.+$/.test(repo)
    ? `${owner}/${repo}`.toLowerCase()
    : null;
}

/** The repository a `-R` value or `GH_REPO` names: `OWNER/REPO`, `HOST/OWNER/REPO` or a URL. */
export function repoOfName(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    : text;
  return lastTwo(path);
}

/** The repository a git remote URL names: https, `ssh://` or `user@host:owner/repo` form; `null` for a local path or anything else. */
export function repoOfRemote(url: string): string | null {
  const text = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/[^/]+(\/.*)$/i.exec(text);
  if (scheme !== null)
    return scheme[1]?.toLowerCase() === "file"
      ? null
      : lastTwo(scheme[2] ?? "");
  // The scp-like form: `[user@]host:path`, where the host has no slash.
  const scp = /^(?:[^@/\s]+@)?[^:/\s]+:(?!\/\/)(.+)$/.exec(text);
  if (scp === null || /^[a-z]:[\\/]/i.test(text)) return null;
  return lastTwo(scp[1] ?? "");
}

/**
 * The repository a command line's `-R`/`--repo` names, else the one a
 * positional `https://HOST/OWNER/REPO/(pull|issues|…)/N` argument names;
 * `null` when it names none. The positional arguments are those left when
 * the flags and their values are skipped, so a URL inside `--body` is
 * content, and a `gh api` URL is a route, never a repository page.
 */
export function repoFlag(args: readonly string[]): string | null {
  const positional: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") break;
    if (VALUED.has(arg) || TEXT_VALUED.has(arg)) i += 1;
    else if (isRepoFlag(arg))
      return repoOfName(repoFlagValue(arg, args[i + 1]));
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  return args[0] === "api" ? null : positionalUrlRepo(positional);
}

/** Whether `arg` is `-R`, `--repo`, or either with its value attached. */
function isRepoFlag(arg: string): boolean {
  return arg.startsWith("-R") || arg === "--repo" || arg.startsWith("--repo=");
}

/** The value of the repository flag `arg`: attached to it, else the next word. */
function repoFlagValue(
  arg: string,
  next: string | undefined,
): string | undefined {
  if (arg === "-R" || arg === "--repo") return next;
  return arg.startsWith("--repo=")
    ? arg.slice(7)
    : arg.slice(2).replace(/^=/, "");
}

/** The repository the first positional repository-page URL of `positional` names; `null` when there is none. */
function positionalUrlRepo(positional: readonly string[]): string | null {
  for (const arg of positional) {
    const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/[^/]+/i.exec(arg);
    if (match !== null) return lastTwo(`${match[1]}/${match[2]}`);
  }
  return null;
}

/** The repository a `gh api` route under `repos/<owner>/<repo>` names; `null` for any other run. */
export function apiRepo(args: readonly string[]): string | null {
  if (args[0] !== "api") return null;
  const match = /^repos\/([^/]+)\/([^/]+)/.exec(apiRoute(args));
  return match === null ? null : lastTwo(`${match[1]}/${match[2]}`);
}

/** The most directories whose remote this process keeps an answer for. */
const ORIGINS_KEPT = 256;

/** How long a read of a directory's remote is reused, so a changed remote is read again. */
const ORIGIN_TTL_MS = 30_000;

/** What this process read of each directory's repository, by its resolved path. */
const origins = new Map<string, { repo: string | null; at: number }>();

/** One local `git config` read of `dir`: its stdout, or `null` when the read failed (a spawn error, a timeout), which is not an absence. */
function gitConfig(dir: string, args: readonly string[]): string | null {
  try {
    // Scrubbed of the variables that point git at another repository, so
    // the answer is about the directory asked about.
    const read = spawnSync("git", ["-C", dir, "config", ...args], {
      env: gitIdentityEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ORIGIN_DEADLINE_MS,
      windowsHide: true,
    });
    if (read.error !== undefined || typeof read.stdout !== "string")
      return null;
    // Exit 1 is git's "no such key"; anything else is a failed read.
    return read.status === 0 || read.status === 1 ? read.stdout : null;
  } catch (error) {
    swallow(error, "a directory whose remote cannot be read addresses none");
    return null;
  }
}

/**
 * The repository the client addresses for an unqualified command in `dir`:
 * the remote `gh repo set-default` chose (`remote.<name>.gh-resolved`),
 * else the `origin` remote; `null` when there is none or it cannot be read.
 * A successful read is reused for a short while; a failed one is not kept.
 */
export function originRepo(dir: string): string | null {
  const at = resolve(dir);
  const known = origins.get(at);
  if (known !== undefined && currentMs() - known.at < ORIGIN_TTL_MS)
    return known.repo;
  let remote = "origin";
  const resolved = gitConfig(at, [
    "--get-regexp",
    "^remote\\..*\\.gh-resolved$",
  ]);
  if (resolved === null) return null;
  for (const line of resolved.split("\n")) {
    const match = /^remote\.(.+)\.gh-resolved\s+(\S+)/.exec(line);
    if (match === null) continue;
    if (match[2] === "base") remote = match[1] ?? remote;
    else {
      const named = repoOfName(match[2]);
      if (named !== null) return keep(at, named);
    }
  }
  const url = gitConfig(at, ["--get", `remote.${remote}.url`]);
  if (url === null) return null;
  return keep(at, repoOfRemote(url));
}

/** Remember `repo` as the answer for `at`, dropping the oldest entry past the bound. */
function keep(at: string, repo: string | null): string | null {
  origins.delete(at);
  origins.set(at, { repo, at: currentMs() });
  if (origins.size > ORIGINS_KEPT) {
    const oldest = origins.keys().next().value;
    if (oldest !== undefined) origins.delete(oldest);
  }
  return repo;
}

/**
 * The repository a run of `gh` with `args`, `env` and working directory
 * `cwd` (the process's when left out) addresses, for the client's stored
 * login; `null` for a token in the environment or a run that addresses none.
 */
export function ghRunScope(
  args: readonly string[],
  env: Env,
  cwd?: string,
): string | null {
  if (githubToken(env) !== null) return null;
  return (
    repoFlag(args) ??
    apiRepo(args) ??
    repoOfName(env.GH_REPO) ??
    originRepo(cwd ?? process.cwd())
  );
}

/**
 * The key a stored login's owner is kept under for the repository `scope`:
 * the credential's own key when the run has no scope, so a mapping kept
 * before scopes existed keeps being read.
 */
export function scopedCredential(
  credential: string,
  scope: string | null | undefined,
): string {
  return scope == null
    ? credential
    : credentialKey("github", `${credential}#repo:${scope}`);
}
