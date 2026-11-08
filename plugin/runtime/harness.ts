/**
 * The `jig` plugin in each agent harness on this machine, Claude Code and
 * Codex, whichever command-line tools exist: installing it, updating it to
 * the newest release of the channel the machine follows, and reading what is
 * installed and what it follows. `jig upgrade` (`upgrade.ts`) runs the
 * install and update, `jig doctor` reads the state, and
 * `tools/plugin/setup.ts` calls both from a checkout for the first install,
 * before `jig` is on `PATH`.
 *
 * Every command that changes something is printed before it runs. It writes
 * only the harnesses' own user-level plugin settings and caches; it never
 * touches a repository. Each tool command is limited to
 * `JIG_SETUP_TIMEOUT_SECONDS` (default 300), so a stalled fetch fails rather
 * than hangs.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN = "jig";
const MARKETPLACE = "jig";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
export const DEFAULT_SOURCE = "https://github.com/jig-harness/jig.git";

/** A request that cannot be carried out as given: the command line contradicts itself. */
export class UpgradeRequestError extends Error {
  override name = "UpgradeRequestError";
}

/**
 * A harness that could not be used: a tool command that failed, stalled or
 * answered something unreadable, a named harness not on `PATH`, or a
 * marketplace registered from a source other than the one asked for.
 */
class HarnessError extends Error {
  override name = "HarnessError";
}

/** The release channels, each a branch of the repository (plugin/README.md). */
export const CHANNELS = ["latest", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];
/** The channel a fresh install follows. */
const DEFAULT_CHANNEL: Channel = "stable";

export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Where progress lines go: standard output, or standard error when a report goes to standard output. */
export type Say = (line: string) => void;

export interface Installed {
  version: string;
  enabled: boolean;
  /** The folder Claude Code loads the plugin from in place, from a local marketplace: no cache copy. */
  inPlace?: string;
}

/** The program that runs each harness: the absolute path a job recorded, else its name on `PATH`. */
export type Programs = Partial<Record<Harness, string>>;

/** Upper bound per tool command, so a stalled fetch cannot hold an upgrade forever. */
export function commandTimeoutMs(): number {
  const raw = process.env.JIG_SETUP_TIMEOUT_SECONDS;
  const seconds = raw === undefined || raw === "" ? 300 : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new UpgradeRequestError(
      `JIG_SETUP_TIMEOUT_SECONDS must be a positive number of seconds, got ${raw}`,
    );
  return seconds * 1000;
}

/** Runs one tool command; given `say`, prints it first. */
function run(command: string, args: string[], say?: Say): string {
  say?.(`$ ${[command, ...args].join(" ")}`);
  const timeout = commandTimeoutMs();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error && code(result.error) === "ETIMEDOUT")
    throw new HarnessError(
      `${command} ${args.join(" ")} did not finish within ${timeout / 1000}s (JIG_SETUP_TIMEOUT_SECONDS)`,
    );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new HarnessError(
      `${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function json(command: string, args: string[]): unknown {
  const output = run(command, args);
  try {
    return JSON.parse(output);
  } catch {
    throw new HarnessError(
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
 * an upgrade or a check never skips a tool it could not inspect.
 */
export function available(
  command: Harness,
  program: string = command,
): boolean {
  const timeout = commandTimeoutMs();
  const result = spawnSync(program, ["--version"], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error && code(result.error) === "ENOENT") return false;
  if (result.error && code(result.error) === "ETIMEDOUT")
    throw new HarnessError(
      `${command} --version did not finish within ${timeout / 1000}s (JIG_SETUP_TIMEOUT_SECONDS)`,
    );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new HarnessError(
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
  if (!entry) return null;
  const folder = entry.readFromFolder;
  return {
    version: String(entry.version),
    enabled: entry.enabled === true,
    ...(typeof folder === "string" && folder ? { inPlace: folder } : {}),
  };
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
    throw new HarnessError(
      `${join(home, "config.toml")} is not TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Split `<base>#<ref>` into the address and the ref, if it names one. */
function splitSource(source: string): { base: string; ref?: string } {
  const at = source.indexOf("#");
  return at < 0
    ? { base: source }
    : { base: source.slice(0, at), ref: source.slice(at + 1) };
}

/** Whether a source is a Git address rather than a directory. */
function isGitAddress(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/.test(source);
}

/**
 * What a registered source follows, in words: a channel, `main` (the source
 * address, which receives each version before its gates pass, with or
 * without `#main`), a version tag it is pinned to, another ref, or a
 * directory.
 */
export function describeSource(registered: Registered): string {
  const { ref } = splitSource(registered.location);
  if (!registered.git) return `the directory ${registered.location}`;
  if (followsMain(ref)) return "main, the source address";
  if ((CHANNELS as readonly string[]).includes(ref as string))
    return `the ${ref} channel`;
  if (/^v\d+\.\d+\.\d+$/.test(ref as string)) return `${ref}, pinned`;
  return `the ref ${ref}`;
}

/**
 * Whether a registered source receives new releases: a Git address at a
 * channel or at `main`. A version tag or another ref is a pin, and a
 * directory is a folder someone maintains by hand.
 */
export function followsReleases(registered: Registered): boolean {
  const { ref } = splitSource(registered.location);
  return (
    registered.git &&
    (followsMain(ref) || (CHANNELS as readonly string[]).includes(ref ?? ""))
  );
}

/** Whether a registered ref follows `main`: none, or `main` named outright. */
export function followsMain(ref: string | undefined): boolean {
  return ref === undefined || ref === "main" || ref === "refs/heads/main";
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
  throw new HarnessError(
    `${harness}: the ${MARKETPLACE} marketplace is registered from ${registered.location}, not ${requested}. To switch, run \`${remove}\` (it uninstalls ${PLUGIN_ID} too) and rerun this command, which installs it again; repositories that enable ${PLUGIN_ID} need no change.`,
  );
}

/** After an update, point a machine that follows `main` at a channel. */
function adviseChannel(harness: Harness, registered: Registered): void {
  const { base, ref } = splitSource(registered.location);
  if (!registered.git || !followsMain(ref)) return;
  // A marketplace added as `owner/repo` is a Git address an upgrade cannot take.
  const source = isGitAddress(base) ? base : DEFAULT_SOURCE;
  console.warn(
    `${harness}: ${PLUGIN_ID} follows main, the source address, which receives each version before its gates pass. To follow a release channel instead: jig upgrade --${harness} --channel ${DEFAULT_CHANNEL} --source ${source}`,
  );
}

export function registeredMarketplace(
  harness: Harness,
  program: string = harness,
): Registered | null {
  return harness === "claude"
    ? claudeMarketplace(
        json(program, ["plugin", "marketplace", "list", "--json"]),
      )
    : codexMarketplace(
        json(program, ["plugin", "marketplace", "list", "--json"]),
        codexConfig(),
      );
}

export function installed(
  harness: Harness,
  program: string = harness,
): Installed | null {
  return harness === "claude"
    ? claudeUserInstall(json(program, ["plugin", "list", "--json"]))
    : codexInstall(json(program, ["plugin", "list", "--json"]));
}

/** Installs or updates the plugin in `harness`; what was installed before. */
function install(
  harness: Harness,
  program: string,
  registered: Registered | null,
  source: string,
  explicit: boolean,
  say: Say,
): Installed | null {
  if (harness === "claude") {
    if (registered === null) {
      run(program, ["plugin", "install", PLUGIN, "--marketplace", source], say);
      return null;
    }
    refuseOtherSource(harness, registered, source, explicit);
    run(program, ["plugin", "marketplace", "update", MARKETPLACE], say);
    const current = installed(harness, program);
    if (current === null)
      run(program, ["plugin", "install", PLUGIN_ID, "--scope", "user"], say);
    // An unscoped update picks the most specific installed scope; this
    // command manages the user-scope install only.
    else run(program, ["plugin", "update", PLUGIN_ID, "--scope", "user"], say);
    adviseChannel(harness, registered);
    return current;
  }
  if (registered === null) {
    // Codex takes the ref as an option, not in the address.
    const { base, ref } = splitSource(source);
    run(
      program,
      ["plugin", "marketplace", "add", base, ...(ref ? ["--ref", ref] : [])],
      say,
    );
  } else {
    refuseOtherSource(harness, registered, source, explicit);
    // Only Git marketplaces have a snapshot to refresh; a local path is live.
    if (registered.git)
      run(program, ["plugin", "marketplace", "upgrade", MARKETPLACE], say);
    adviseChannel(harness, registered);
  }
  const current = installed(harness, program);
  // Adding again reinstalls the marketplace's current version.
  run(program, ["plugin", "add", PLUGIN_ID], say);
  return current;
}

/**
 * What an upgrade or a check asks for. `source` is what a fresh install
 * registers; `explicit` is set when something chose it (an option or
 * `JIG_MARKETPLACE`), so a harness registered elsewhere is refused;
 * `defaulted` when nothing did, so a fresh install follows
 * {@link DEFAULT_CHANNEL} (or `latest`, until `stable` has its first version).
 */
export interface HarnessRequest {
  source: string;
  explicit: boolean;
  defaulted: boolean;
  only: Harness | null;
  /** The programs to run each harness by; a harness not named runs by its name on `PATH`. */
  programs?: Programs;
}

/** The program that runs `harness` for `request`. */
function programOf(harness: Harness, request: HarnessRequest): string {
  return request.programs?.[harness] ?? harness;
}

/** The request for `--source`, `--channel` and `--claude`/`--codex` as given. */
export function harnessRequest(
  options: { source?: string; channel?: Channel; only?: Harness | null },
  env: NodeJS.ProcessEnv = process.env,
): HarnessRequest {
  const fromEnv = env.JIG_MARKETPLACE;
  const source = options.source ?? (fromEnv || DEFAULT_SOURCE);
  const explicit = options.source !== undefined || Boolean(fromEnv);
  const only = options.only ?? null;
  if (options.channel !== undefined)
    return {
      source: atChannel(source, options.channel),
      explicit: true,
      defaulted: false,
      only,
    };
  return { source, explicit, defaulted: !explicit, only };
}

/** `source` at `channel`'s ref; refused where a channel cannot apply. */
function atChannel(source: string, channel: Channel): string {
  if (splitSource(source).ref !== undefined)
    throw new UpgradeRequestError(
      `--channel and a source that names a ref (${source}) contradict each other; give one`,
    );
  if (!isGitAddress(source))
    throw new UpgradeRequestError(
      `--channel needs a Git address; ${source} is a directory, which has no channels`,
    );
  return `${source}#${channel}`;
}

/**
 * What became of one harness: `skipped` when it is not on `PATH`; after an
 * upgrade `installed`, `updated` or `unchanged`; after a check `present`;
 * `missing` when the plugin is not installed or is disabled at the end; and
 * `failed` when a command failed or the request was refused.
 */
export interface HarnessResult {
  harness: Harness;
  outcome:
    | "installed"
    | "updated"
    | "unchanged"
    | "present"
    | "missing"
    | "skipped"
    | "failed";
  /** The version before an upgrade, when it was installed. */
  before?: string;
  /** The version installed at the end. */
  version?: string;
  /** What the registered source follows, in words. */
  follows?: string;
  detail: string;
}

/** Prints what `harness` has installed and follows. */
function report(
  harness: Harness,
  say: Say,
  program: string = harness,
): { state: Installed | null; follows?: string; line: string } {
  const state = installed(harness, program);
  if (state === null || !state.enabled) {
    const line = `${harness}: ${PLUGIN_ID} ${state === null ? "is not installed for this user" : "is installed but disabled"}`;
    say(line);
    return { state, line };
  }
  const registered = registeredMarketplace(harness, program);
  const follows = registered ? describeSource(registered) : undefined;
  const line = `${harness}: ${PLUGIN_ID} ${state.version} enabled${follows ? `, following ${follows}` : ""}`;
  say(line);
  return { state, ...(follows ? { follows } : {}), line };
}

/**
 * The source a fresh install registers when nothing chose one: the default
 * channel, or `latest` while that channel has no version yet.
 */
function defaultChannelSource(say: Say): string {
  const timeout = commandTimeoutMs();
  const result = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--heads", DEFAULT_SOURCE, DEFAULT_CHANNEL],
    { encoding: "utf8", timeout, killSignal: "SIGKILL" },
  );
  if (result.status === 0) return `${DEFAULT_SOURCE}#${DEFAULT_CHANNEL}`;
  // 2: the remote answered and has no such branch.
  if (result.status === 2) {
    say(`the ${DEFAULT_CHANNEL} channel has no version yet; following latest`);
    return `${DEFAULT_SOURCE}#latest`;
  }
  throw new HarnessError(
    `git ls-remote ${DEFAULT_SOURCE} failed: ${(result.stderr || result.error?.message || "").trim()}`,
  );
}

/**
 * Runs `step` for each harness the request selects, in turn. A harness that
 * fails is reported on standard error and recorded as `failed`, and the next
 * one still runs.
 */
function eachHarness(
  request: HarnessRequest,
  step: (harness: Harness) => HarnessResult,
): HarnessResult[] {
  const results = HARNESSES.filter(
    (harness) => request.only === null || request.only === harness,
  ).map((harness): HarnessResult => {
    try {
      return step(harness);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(detail);
      return { harness, outcome: "failed", detail };
    }
  });
  if (results.every((result) => result.outcome === "skipped"))
    console.error("neither claude nor codex is on PATH");
  return results;
}

/** `skipped` for a harness not on `PATH`, unless the request named it. */
function absent(
  harness: Harness,
  request: HarnessRequest,
  say: Say,
): HarnessResult | null {
  if (available(harness, programOf(harness, request))) return null;
  if (request.only !== null)
    throw new HarnessError(`${harness} is not on PATH`);
  say(`${harness}: not on PATH, skipped`);
  return { harness, outcome: "skipped", detail: "not on PATH" };
}

/**
 * Installs the plugin in each harness on `PATH` that lacks it, and updates
 * it to the newest release of the channel it follows where it has it; then
 * reports each.
 */
export function upgradeHarnesses(
  request: HarnessRequest,
  say: Say = console.log,
): HarnessResult[] {
  // The default channel is looked up once, and only for a fresh install.
  let fresh: string | null = request.defaulted ? null : request.source;
  const freshSource = () => {
    fresh ??= defaultChannelSource(say);
    return fresh;
  };
  return eachHarness(request, (harness) => {
    const skipped = absent(harness, request, say);
    if (skipped !== null) return skipped;
    const program = programOf(harness, request);
    const registered = registeredMarketplace(harness, program);
    const before = install(
      harness,
      program,
      registered,
      registered === null ? freshSource() : request.source,
      request.explicit,
      say,
    );
    const after = report(harness, say, program);
    return outcome(harness, before, after);
  });
}

function outcome(
  harness: Harness,
  before: Installed | null,
  after: ReturnType<typeof report>,
): HarnessResult {
  const { state, follows, line } = after;
  const common = {
    harness,
    ...(before === null ? {} : { before: before.version }),
    ...(state === null ? {} : { version: state.version }),
    ...(follows === undefined ? {} : { follows }),
    detail: line,
  };
  if (state === null || !state.enabled)
    return { ...common, outcome: "missing" };
  if (before === null) return { ...common, outcome: "installed" };
  return {
    ...common,
    outcome: before.version === state.version ? "unchanged" : "updated",
  };
}

/** Reports what each harness on `PATH` has installed and follows, changing nothing. */
export function checkHarnesses(
  request: HarnessRequest,
  say: Say = console.log,
): HarnessResult[] {
  return eachHarness(request, (harness) => {
    const skipped = absent(harness, request, say);
    if (skipped !== null) return skipped;
    const { state, follows, line } = report(
      harness,
      say,
      programOf(harness, request),
    );
    return {
      harness,
      outcome: state?.enabled === true ? "present" : "missing",
      ...(state === null ? {} : { version: state.version }),
      ...(follows === undefined ? {} : { follows }),
      detail: line,
    };
  });
}

/**
 * 0 when every harness on `PATH` ends with the plugin installed and enabled;
 * 1 when one failed or lacks it, or when no harness is on `PATH`.
 */
export function harnessesExit(results: readonly HarnessResult[]): number {
  if (results.every((result) => result.outcome === "skipped")) return 1;
  return results.some(
    (result) => result.outcome === "failed" || result.outcome === "missing",
  )
    ? 1
    : 0;
}
