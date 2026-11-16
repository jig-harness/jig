/**
 * The two identities of a GitHub credential in the machine's budget
 * database (`budget.ts`).
 *
 * - **The credential** is what the client sends: a hash of the token, or for
 *   the client's own stored login, of the host, the configuration directory
 *   and the account the client's `hosts.yml` names as active for that host.
 *   It keys the ledger's rows and every cache of answers, since what one
 *   credential may read another may not.
 * - **The quota owner** is whose allowance a request spends: GitHub counts
 *   the primary limits per user for every personal token of that user
 *   (classic or fine-grained) and per installation for every installation
 *   token. The owner's key is a hash of the host and `user:<numeric id>` or
 *   `installation:<numeric id>`; the numeric id, never the login, since a
 *   login can be renamed. `github-owner.ts` says how it is found.
 *
 * Reading `hosts.yml` is a local file read, no request: the active account
 * is the `user:` line of the host's block, read by a small reader rather
 * than a YAML library, and a file that cannot be read leaves the account out
 * of the key. An account switch therefore makes a new credential key, which
 * inherits nothing the previous account's key learnt.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialKey } from "./budget.ts";
import { swallow } from "../errors.ts";

type Env = Record<string, string | undefined>;

/** The variable that declares the installation an installation token belongs to. */
const INSTALLATION_ENV = "JIG_GITHUB_INSTALLATION_ID";

/** The host the client talks to: `GH_HOST`, lowercased, else github.com. */
export function githubHost(env: Env = process.env): string {
  return env.GH_HOST?.trim().toLowerCase() || "github.com";
}

/** The token the client sends from the environment; `null` when it uses its stored login. */
export function githubToken(env: Env = process.env): string | null {
  const host = env.GH_HOST?.trim() ?? "";
  // The client reads the Enterprise variables for an Enterprise Server host,
  // and the others for github.com and its cloud and local tenancies.
  const name = host.toLowerCase();
  const enterprise =
    host !== "" &&
    name !== "github.com" &&
    !name.endsWith(".ghe.com") &&
    !name.endsWith(".github.localhost") &&
    name !== "github.localhost";
  const token = enterprise
    ? env.GH_ENTERPRISE_TOKEN?.trim() || env.GITHUB_ENTERPRISE_TOKEN?.trim()
    : env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  return token || null;
}

/** What the stored login's key was made of before it named the account. */
function storedLoginSeed(env: Env): string {
  const host = env.GH_HOST?.trim() ?? "";
  const config = env.GH_CONFIG_DIR?.trim() ?? "";
  return host === "" && config === ""
    ? "opaque-cli-credential"
    : `opaque-cli-credential:${host}:${config}`;
}

/**
 * The credential's key: a hash of the token the client sends, or for its
 * stored login, of the host and the configuration directory it resolves and the
 * account `hosts.yml` names as active there (left out when the file cannot
 * be read). A host named only on a command line is not an input here.
 */
export function githubCredential(env: Env = process.env): string {
  const token = githubToken(env);
  if (token !== null) return credentialKey("github", token);
  const account = activeAccount(env);
  // The directory the client resolves, so two environments that leave it
  // unset but resolve different homes are not the same credential.
  const seed = `opaque-cli-credential:${env.GH_HOST?.trim() ?? ""}:${ghConfigDir(env)}`;
  return credentialKey(
    "github",
    account === null ? seed : `${seed}#user:${account}`,
  );
}

/**
 * The key an earlier release kept the credential's record under: the same
 * as `githubCredential` for a token, the stored login's key without its
 * account. Read only to carry a record over to its owner.
 */
export function legacyGithubCredential(env: Env = process.env): string {
  const token = githubToken(env);
  return credentialKey("github", token ?? storedLoginSeed(env));
}

/** Whether the client sends an installation token, which cannot name its own installation. */
export function installationToken(env: Env = process.env): boolean {
  return githubToken(env)?.startsWith("ghs_") === true;
}

/** The installation the token issuer declared for the token (`JIG_GITHUB_INSTALLATION_ID`); `null` when it declared none that reads. */
export function declaredInstallation(env: Env = process.env): number | null {
  const text = env[INSTALLATION_ENV]?.trim() ?? "";
  if (!/^[1-9]\d{0,15}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** The record of a user's allowance on `host`. */
export function userOwner(host: string, id: number): string {
  return credentialKey("github", `owner:${host}:user:${id}`);
}

/** The record of an installation's allowance on `host`. */
export function installationOwner(host: string, id: number): string {
  return credentialKey("github", `owner:${host}:installation:${id}`);
}

/** The one record every credential on `host` whose owner is not established shares. */
export function unverifiedOwner(host: string): string {
  return credentialKey("github", `owner:${host}:unverified`);
}

/** The client's configuration directory, as the client finds it. */
function ghConfigDir(env: Env = process.env): string {
  const explicit = env.GH_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "gh");
  const appData = (env.APPDATA ?? env.AppData)?.trim();
  if (process.platform === "win32" && appData)
    return join(appData, "GitHub CLI");
  return join(env.HOME?.trim() || homedir(), ".config", "gh");
}

/** The account `hosts.yml` text names as active for `host`: the `user:` line directly under the host's block. */
export function activeUserIn(text: string, host: string): string | null {
  let inHost = false;
  let indent: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      const key = /^(["']?)([^"':]+)\1:\s*$/.exec(line.trimEnd());
      inHost = key?.[2]?.trim().toLowerCase() === host;
      indent = null;
      continue;
    }
    if (!inHost) continue;
    indent ??= lead;
    if (lead !== indent) continue;
    const user = /^user:\s*(["']?)([^"'\s]+)\1\s*$/.exec(line.trim());
    if (user === null) continue;
    const login = user[2] ?? "";
    return /^[A-Za-z0-9-]+$/.test(login) ? login : null;
  }
  return null;
}

/** What this process last read of each `hosts.yml`, by path: reread when the file changes. */
const readHosts = new Map<
  string,
  { mtimeMs: number; size: number; text: string }
>();

/** The account the client's stored login is for on the host `env` names; `null` when it cannot be read. */
function activeAccount(env: Env = process.env): string | null {
  const path = join(ghConfigDir(env), "hosts.yml");
  try {
    const stat = statSync(path);
    let held = readHosts.get(path);
    if (
      held === undefined ||
      held.mtimeMs !== stat.mtimeMs ||
      held.size !== stat.size
    ) {
      held = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        text: readFileSync(path, "utf8"),
      };
      readHosts.set(path, held);
    }
    return activeUserIn(held.text, githubHost(env));
  } catch (error) {
    swallow(error, "a stored login whose account cannot be read stays opaque");
    return null;
  }
}
