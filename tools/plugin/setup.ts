#!/usr/bin/env bun
/**
 * Install, update or check the `jig` plugin for every agent harness on
 * this machine: Claude Code and Codex, whichever command-line tools exist.
 *
 * Usage:
 *   bun tools/plugin/setup.ts            install, or update to the newest release
 *                                        of the channel the machine follows
 *   bun tools/plugin/setup.ts --check    report what is installed; exit 1 if missing
 *   options: --channel latest|stable     follow that release channel (a fresh
 *                                        install follows stable); refused when
 *                                        the marketplace is registered at another
 *            --source <marketplace>      install from this source instead of
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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cli } from "../../lib/cli.ts";

export const PLUGIN = "jig";
export const MARKETPLACE = "jig";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
export const DEFAULT_SOURCE = "https://github.com/jig-harness/jig.git";

/** A setup request that cannot be carried out as given. */
class SetupError extends Error {
  override name = "SetupError";
}

/** The release channels, each a branch of the repository (plugin/README.md). */
export const CHANNELS = ["latest", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];
/** The channel a fresh install follows. */
export const DEFAULT_CHANNEL: Channel = "stable";

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

/**
 * Codex's list leaves out the ref a Git marketplace was added at, so it is
 * read from the configuration the list comes from (`ref`, under
 * `[marketplaces.<name>]` in `config.toml`).
 */
export function codexMarketplace(
  list: unknown,
  config: unknown = null,
): Registered | null {
  const marketplaces = (list as { marketplaces?: unknown })?.marketplaces;
  if (!Array.isArray(marketplaces)) return null;
  const entry = marketplaces.find((m) => m?.name === MARKETPLACE);
  if (!entry) return null;
  const location = String(entry.marketplaceSource?.source ?? entry.root ?? "");
  const ref = (config as { marketplaces?: Record<string, { ref?: unknown }> })
    ?.marketplaces?.[MARKETPLACE]?.ref;
  return {
    location: typeof ref === "string" && ref ? `${location}#${ref}` : location,
    git: entry.marketplaceSource?.sourceType === "git",
  };
}

/** Codex's user configuration, or null when it has none. */
function codexConfig(): unknown {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  let text: string;
  try {
    text = readFileSync(join(home, "config.toml"), "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    throw new SetupError(
      `${join(home, "config.toml")} is not TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Split `<base>#<ref>` into the address and the ref, if it names one. */
export function splitSource(source: string): { base: string; ref?: string } {
  const at = source.indexOf("#");
  return at < 0
    ? { base: source }
    : { base: source.slice(0, at), ref: source.slice(at + 1) };
}

/** Whether a source is a Git address rather than a directory. */
export function isGitAddress(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/.test(source);
}

/**
 * What a registered source follows, in words: a channel, `main` (the source
 * address, which receives each version before its gates pass), a pinned ref,
 * or a directory.
 */
export function describeSource(registered: Registered): string {
  const { ref } = splitSource(registered.location);
  if (!registered.git) return `the directory ${registered.location}`;
  if (ref && (CHANNELS as readonly string[]).includes(ref))
    return `the ${ref} channel`;
  if (ref) return `${ref}, pinned`;
  return "main, the source address";
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
      ? `claude plugin marketplace remove ${MARKETPLACE} --scope user`
      : `codex plugin marketplace remove ${MARKETPLACE}`;
  throw new Error(
    `${harness}: the ${MARKETPLACE} marketplace is registered from ${registered.location}, not ${requested}. To switch, run \`${remove}\` (it uninstalls ${PLUGIN_ID} too) and rerun this command, which installs it again; repositories that enable ${PLUGIN_ID} need no change.`,
  );
}

/** After an update, point a machine that follows `main` at a channel. */
function adviseChannel(harness: Harness, registered: Registered): void {
  const { base, ref } = splitSource(registered.location);
  if (!registered.git || ref !== undefined) return;
  // A marketplace added as `owner/repo` is a Git address setup cannot take.
  const source = isGitAddress(base) ? base : DEFAULT_SOURCE;
  console.warn(
    `${harness}: ${PLUGIN_ID} follows main, the source address, which receives each version before its gates pass. To follow a release channel instead: bun tools/plugin/setup.ts --${harness} --channel ${DEFAULT_CHANNEL} --source ${source}`,
  );
}

function registeredMarketplace(harness: Harness): Registered | null {
  return harness === "claude"
    ? claudeMarketplace(
        json("claude", ["plugin", "marketplace", "list", "--json"]),
      )
    : codexMarketplace(
        json("codex", ["plugin", "marketplace", "list", "--json"]),
        codexConfig(),
      );
}

function install(
  harness: Harness,
  registered: Registered | null,
  source: string,
  explicit: boolean,
): void {
  if (harness === "claude") {
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
    adviseChannel(harness, registered);
    return;
  }
  if (registered === null) {
    // Codex takes the ref as an option, not in the address.
    const { base, ref } = splitSource(source);
    run("codex", [
      "plugin",
      "marketplace",
      "add",
      base,
      ...(ref ? ["--ref", ref] : []),
    ]);
  } else {
    refuseOtherSource(harness, registered, source, explicit);
    // Only Git marketplaces have a snapshot to refresh; a local path is live.
    if (registered.git)
      run("codex", ["plugin", "marketplace", "upgrade", MARKETPLACE]);
    adviseChannel(harness, registered);
  }
  // Adding again reinstalls the marketplace's current version.
  run("codex", ["plugin", "add", PLUGIN_ID]);
}

function installed(harness: Harness): Installed | null {
  return harness === "claude"
    ? claudeUserInstall(json("claude", ["plugin", "list", "--json"]))
    : codexInstall(json("codex", ["plugin", "list", "--json"]));
}

/**
 * The command line. `source` is what a fresh install registers: the given
 * source, at `--channel`'s ref when one is given. `defaulted` is set when
 * nothing chose the source, so a fresh install follows {@link DEFAULT_CHANNEL}
 * (or `latest`, until `stable` has its first version).
 */
export function parse(argv: string[]): {
  check: boolean;
  source: string;
  explicit: boolean;
  defaulted: boolean;
  only: Harness | null;
} {
  let check = false;
  const fromEnv = process.env.JIG_MARKETPLACE;
  let source = fromEnv || DEFAULT_SOURCE;
  let explicit = Boolean(fromEnv);
  let only: Harness | null = null;
  let channel: Channel | null = null;
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
    } else if (arg === "--channel") channel = channelArgument(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (channel !== null)
    return {
      check,
      source: atChannel(source, channel),
      explicit: true,
      defaulted: false,
      only,
    };
  return { check, source, explicit, defaulted: !explicit, only };
}

function channelArgument(value: string | undefined): Channel {
  if (!(CHANNELS as readonly string[]).includes(value ?? ""))
    throw new SetupError(`--channel needs one of: ${CHANNELS.join(", ")}`);
  return value as Channel;
}

/** `source` at `channel`'s ref; refused where a channel cannot apply. */
function atChannel(source: string, channel: Channel): string {
  if (splitSource(source).ref !== undefined)
    throw new SetupError(
      `--channel and a source that names a ref (${source}) contradict each other; give one`,
    );
  if (!isGitAddress(source))
    throw new SetupError(
      `--channel needs a Git address; ${source} is a directory, which has no channels`,
    );
  return `${source}#${channel}`;
}

/** Print what `harness` has installed and follows; whether it is enabled. */
function report(harness: Harness): boolean {
  const state = installed(harness);
  if (state === null || !state.enabled) {
    console.log(
      `${harness}: ${PLUGIN_ID} ${state === null ? "is not installed for this user" : "is installed but disabled"}`,
    );
    return false;
  }
  const registered = registeredMarketplace(harness);
  const follows = registered ? `, following ${describeSource(registered)}` : "";
  console.log(`${harness}: ${PLUGIN_ID} ${state.version} enabled${follows}`);
  return true;
}

/**
 * The source a fresh install registers when nothing chose one: the default
 * channel, or `latest` while that channel has no version yet.
 */
function defaultChannelSource(): string {
  const timeout = commandTimeoutMs();
  const result = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--heads", DEFAULT_SOURCE, DEFAULT_CHANNEL],
    { encoding: "utf8", timeout, killSignal: "SIGKILL" },
  );
  if (result.status === 0) return `${DEFAULT_SOURCE}#${DEFAULT_CHANNEL}`;
  // 2: the remote answered and has no such branch.
  if (result.status === 2) {
    console.log(
      `the ${DEFAULT_CHANNEL} channel has no version yet; following latest`,
    );
    return `${DEFAULT_SOURCE}#latest`;
  }
  throw new SetupError(
    `git ls-remote ${DEFAULT_SOURCE} failed: ${(result.stderr || result.error?.message || "").trim()}`,
  );
}

/**
 * Install or update one harness, then report it: `skipped` when it is not on
 * `PATH`, else whether the plugin is installed and enabled. `source` gives
 * what a fresh install registers, looked up only when one is needed.
 */
function setUp(
  harness: Harness,
  parsed: ReturnType<typeof parse>,
  source: () => string,
): "skipped" | "ok" | "missing" {
  if (!available(harness)) {
    if (parsed.only !== null) throw new Error(`${harness} is not on PATH`);
    console.log(`${harness}: not on PATH, skipped`);
    return "skipped";
  }
  if (!parsed.check) {
    const before = registeredMarketplace(harness);
    install(
      harness,
      before,
      before === null ? source() : parsed.source,
      parsed.explicit,
    );
  }
  return report(harness) ? "ok" : "missing";
}

/** Set up each harness on `PATH`; the exit code. */
function main(parsed: ReturnType<typeof parse>): number {
  // The default channel is looked up once, and only for a fresh install.
  let fresh: string | null = parsed.defaulted ? null : parsed.source;
  const source = () => {
    fresh ??= defaultChannelSource();
    return fresh;
  };
  const outcomes = (["claude", "codex"] as const)
    .filter((harness) => parsed.only === null || parsed.only === harness)
    .map((harness) => setUp(harness, parsed, source));
  if (outcomes.every((outcome) => outcome === "skipped")) {
    console.error("neither claude nor codex is on PATH");
    return 1;
  }
  return outcomes.includes("missing") ? 1 : 0;
}

if (import.meta.main) cli(() => main(parse(process.argv.slice(2))));
