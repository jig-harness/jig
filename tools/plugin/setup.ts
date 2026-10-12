#!/usr/bin/env bun
/**
 * Install, update or check the `jig` plugin for every agent harness on
 * this machine: Claude Code and Codex, whichever command-line tools exist.
 *
 * Usage:
 *   bun tools/plugin/setup.ts            install, or update to the latest release
 *   bun tools/plugin/setup.ts --check    report what is installed; exit 1 if missing
 *   options: --source <marketplace>      install from this source instead of
 *                                        $JIG_MARKETPLACE or the Jig
 *                                        GitHub repository (HTTPS); refused when the
 *                                        marketplace is already registered elsewhere
 *            --claude | --codex          only that harness (required to exist)
 *   JIG_SETUP_TIMEOUT_SECONDS     limit per tool command (default 300)
 *
 * Every command is printed before it runs. It writes only the harnesses' own
 * user-level plugin settings and caches; it never touches a repository.
 */
import { spawnSync } from "node:child_process";
import { cli } from "../../lib/cli.ts";

export const PLUGIN = "jig";
export const MARKETPLACE = "jig";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
export const DEFAULT_SOURCE = "https://github.com/docomply/jig.git";

type Harness = "claude" | "codex";

export interface Installed {
  version: string;
  enabled: boolean;
}

/** Upper bound per tool command, so a stalled fetch cannot hold setup forever. */
export function commandTimeoutMs(): number {
  const raw = process.env.JIG_SETUP_TIMEOUT_SECONDS;
  const seconds = raw === undefined || raw === "" ? 300 : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(
      `JIG_SETUP_TIMEOUT_SECONDS must be a positive number of seconds, got ${raw}`,
    );
  return seconds * 1000;
}

function run(command: string, args: string[], quiet = false): string {
  if (!quiet) console.log(`$ ${[command, ...args].join(" ")}`);
  const timeout = commandTimeoutMs();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error && code(result.error) === "ETIMEDOUT")
    throw new Error(
      `${command} ${args.join(" ")} did not finish within ${timeout / 1000}s (JIG_SETUP_TIMEOUT_SECONDS)`,
    );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function json(command: string, args: string[]): unknown {
  const output = run(command, args, true);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      `${command} ${args.join(" ")} printed unexpected output: ${output.slice(0, 200)}`,
    );
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/**
 * Whether the tool is installed. Only a missing executable (ENOENT) means
 * "not installed"; a version probe that times out or fails is an error, so
 * setup and --check never skip a tool they could not inspect.
 */
function available(command: string): boolean {
  const timeout = commandTimeoutMs();
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error && code(result.error) === "ENOENT") return false;
  if (result.error && code(result.error) === "ETIMEDOUT")
    throw new Error(
      `${command} --version did not finish within ${timeout / 1000}s (JIG_SETUP_TIMEOUT_SECONDS)`,
    );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} --version exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  return true;
}

/**
 * The user-scope install from `claude plugin list --json`. The list has one
 * entry per scope, including project and local installs made for other
 * directories; only the user scope applies in every repository.
 */
export function claudeUserInstall(list: unknown): Installed | null {
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (plugin) => plugin?.id === PLUGIN_ID && plugin?.scope === "user",
  );
  return entry
    ? { version: String(entry.version), enabled: entry.enabled === true }
    : null;
}

/** The install from `codex plugin list --json` (Codex has one scope). */
export function codexInstall(list: unknown): Installed | null {
  const installed = (list as { installed?: unknown })?.installed;
  if (!Array.isArray(installed)) return null;
  const entry = installed.find((plugin) => plugin?.pluginId === PLUGIN_ID);
  return entry
    ? { version: String(entry.version), enabled: entry.enabled === true }
    : null;
}

/** Where a registered marketplace comes from, from either tool's list. */
export interface Registered {
  location: string;
  git: boolean;
}

export function claudeMarketplace(list: unknown): Registered | null {
  if (!Array.isArray(list)) return null;
  const entry = list.find((m) => m?.name === MARKETPLACE);
  if (!entry) return null;
  const location = entry.url ?? entry.repo ?? entry.path ?? "";
  return {
    location: entry.ref ? `${location}#${entry.ref}` : String(location),
    git: entry.source === "git" || entry.source === "github",
  };
}

export function codexMarketplace(list: unknown): Registered | null {
  const marketplaces = (list as { marketplaces?: unknown })?.marketplaces;
  if (!Array.isArray(marketplaces)) return null;
  const entry = marketplaces.find((m) => m?.name === MARKETPLACE);
  if (!entry) return null;
  return {
    location: String(entry.marketplaceSource?.source ?? entry.root ?? ""),
    git: entry.marketplaceSource?.sourceType === "git",
  };
}

/**
 * Compare sources ignoring a trailing `.git` or slash. A requested `#ref` must
 * match the registered one; a request without a ref accepts any registered
 * ref, so an existing pin is kept unless the caller asks for another.
 */
export function sameSource(registered: string, requested: string): boolean {
  const norm = (value: string) => {
    const [base = "", ref] = value.split("#");
    return { base: base.replace(/\/+$/, "").replace(/\.git$/, ""), ref };
  };
  const a = norm(registered);
  const b = norm(requested);
  return a.base === b.base && (b.ref === undefined || a.ref === b.ref);
}

function refuseOtherSource(
  harness: Harness,
  registered: Registered,
  requested: string,
  explicit: boolean,
): void {
  if (!explicit || sameSource(registered.location, requested)) return;
  const remove =
    harness === "claude"
      ? `claude plugin marketplace remove ${MARKETPLACE}`
      : `codex plugin marketplace remove ${MARKETPLACE}`;
  throw new Error(
    `${harness}: the ${MARKETPLACE} marketplace is registered from ${registered.location}, not ${requested}. To switch, run \`${remove}\` and rerun this command.`,
  );
}

function install(harness: Harness, source: string, explicit: boolean): void {
  if (harness === "claude") {
    const registered = claudeMarketplace(
      json("claude", ["plugin", "marketplace", "list", "--json"]),
    );
    if (registered === null) {
      run("claude", ["plugin", "install", PLUGIN, "--marketplace", source]);
      return;
    }
    refuseOtherSource(harness, registered, source, explicit);
    run("claude", ["plugin", "marketplace", "update", MARKETPLACE]);
    const current = claudeUserInstall(
      json("claude", ["plugin", "list", "--json"]),
    );
    if (current === null)
      run("claude", ["plugin", "install", PLUGIN_ID, "--scope", "user"]);
    // An unscoped update picks the most specific installed scope; this
    // command manages the user-scope install only.
    else run("claude", ["plugin", "update", PLUGIN_ID, "--scope", "user"]);
    return;
  }
  const registered = codexMarketplace(
    json("codex", ["plugin", "marketplace", "list", "--json"]),
  );
  if (registered === null)
    run("codex", ["plugin", "marketplace", "add", source]);
  else {
    refuseOtherSource(harness, registered, source, explicit);
    // Only Git marketplaces have a snapshot to refresh; a local path is live.
    if (registered.git)
      run("codex", ["plugin", "marketplace", "upgrade", MARKETPLACE]);
  }
  // Adding again reinstalls the marketplace's current version.
  run("codex", ["plugin", "add", PLUGIN_ID]);
}

function installed(harness: Harness): Installed | null {
  return harness === "claude"
    ? claudeUserInstall(json("claude", ["plugin", "list", "--json"]))
    : codexInstall(json("codex", ["plugin", "list", "--json"]));
}

export function parse(argv: string[]): {
  check: boolean;
  source: string;
  explicit: boolean;
  only: Harness | null;
} {
  let check = false;
  const fromEnv = process.env.JIG_MARKETPLACE;
  let source = fromEnv || DEFAULT_SOURCE;
  let explicit = Boolean(fromEnv);
  let only: Harness | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--claude" || arg === "--codex")
      only = arg.slice(2) as Harness;
    else if (arg === "--source") {
      const value = argv[++i];
      if (!value) throw new Error("--source needs a marketplace source");
      source = value;
      explicit = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { check, source, explicit, only };
}

if (import.meta.main)
  cli(() => {
    const { check, source, explicit, only } = parse(process.argv.slice(2));
    const harnesses = (["claude", "codex"] as const).filter(
      (harness) => only === null || only === harness,
    );
    let missing = 0;
    let found = 0;
    for (const harness of harnesses) {
      if (!available(harness)) {
        if (only !== null) throw new Error(`${harness} is not on PATH`);
        console.log(`${harness}: not on PATH, skipped`);
        continue;
      }
      found++;
      if (!check) install(harness, source, explicit);
      const state = installed(harness);
      if (state === null || !state.enabled) {
        missing++;
        console.log(
          `${harness}: ${PLUGIN_ID} ${state === null ? "is not installed for this user" : "is installed but disabled"}`,
        );
      } else console.log(`${harness}: ${PLUGIN_ID} ${state.version} enabled`);
    }
    if (found === 0) {
      console.error("neither claude nor codex is on PATH");
      return 1;
    }
    return missing === 0 ? 0 : 1;
  });
