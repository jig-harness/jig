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
 *    segments;
 * 2. for `gh api`, a route that starts `repos/<owner>/<repo>`;
 * 3. `GH_REPO` in the run's environment;
 * 4. the `origin` remote of the run's working directory, read by a local
 *    `git config` run (no network, a 2-second deadline), once per directory
 *    in a process. A remote in https, `ssh://` or `user@host:owner/repo`
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

type Env = Record<string, string | undefined>;

/** How long the local `git config` read of a directory's remote may take. */
const ORIGIN_DEADLINE_MS = 2_000;

/** Flags of the common subcommands whose value is free text, never a flag. */
const TEXT_VALUED = new Set([
  "-b",
  "--body",
  "--title",
  "-m",
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

/** The repository a command line's `-R`/`--repo` names; `null` when it names none. */
export function repoFlag(args: readonly string[]): string | null {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") return null;
    if (VALUED.has(arg) || TEXT_VALUED.has(arg)) {
      i += 1;
      continue;
    }
    if (arg === "-R" || arg === "--repo") return repoOfName(args[i + 1]);
    if (arg.startsWith("--repo=")) return repoOfName(arg.slice(7));
    if (arg.startsWith("-R")) return repoOfName(arg.slice(2).replace(/^=/, ""));
  }
  return null;
}

/** The repository a `gh api` route under `repos/<owner>/<repo>` names; `null` for any other run. */
export function apiRepo(args: readonly string[]): string | null {
  if (args[0] !== "api") return null;
  const match = /^repos\/([^/]+)\/([^/]+)/.exec(apiRoute(args));
  return match === null ? null : lastTwo(`${match[1]}/${match[2]}`);
}

/** What this process read of each directory's `origin` remote, by its resolved path. */
const origins = new Map<string, string | null>();

/** The repository the `origin` remote of `dir` names; `null` when there is none or it cannot be read. */
export function originRepo(dir: string): string | null {
  const at = resolve(dir);
  const known = origins.get(at);
  if (known !== undefined) return known;
  let found: string | null = null;
  try {
    // Scrubbed of the variables that point git at another repository, so
    // the answer is the remote of the directory asked about.
    const read = spawnSync(
      "git",
      ["-C", at, "config", "--get", "remote.origin.url"],
      {
        env: gitIdentityEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: ORIGIN_DEADLINE_MS,
        windowsHide: true,
      },
    );
    if (read.status === 0 && typeof read.stdout === "string")
      found = repoOfRemote(read.stdout);
  } catch (error) {
    swallow(error, "a directory whose remote cannot be read addresses none");
  }
  origins.set(at, found);
  return found;
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
