/**
 * The `jig` plugin in each agent harness on this machine, Claude Code and
 * Codex, whichever command-line tools exist: installing it, updating it to
 * the newest release of the channel the machine follows, and reading what is
 * installed and what it follows. `jig upgrade` (`upgrade.ts`) runs the
 * install and update, `jig doctor` reads the state, and
 * `tools/plugin/setup.ts` calls both from a checkout for the first install,
 * before `jig` is on `PATH`.
 *
 * Claude Code also keeps an install per directory it was installed for
 * (project and local scope); `scoped-installs.ts` refreshes those after the
 * user-scope install.
 *
 * Every command that changes something is printed before it runs. It writes
 * only the harnesses' own plugin settings and caches; it never touches a
 * repository's files. Each tool command is limited to
 * `JIG_SETUP_TIMEOUT_SECONDS` (default 300), so a stalled fetch fails rather
 * than hangs.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import {
  code,
  commandTimeoutMs,
  HarnessError,
  json,
  MARKETPLACE,
  PLUGIN,
  PLUGIN_ID,
  reason,
  run,
  type Say,
  UpgradeRequestError,
} from "./harness-command.ts";
import {
  directoryState,
  refreshScoped,
  type ScopedResult,
  scopedInstalls,
} from "./scoped-installs.ts";
import {
  type Channel,
  type Registered,
  splitSource,
  isGitAddress,
  describeSource,
  followsMain,
  sameSource,
} from "./harness-source.ts";
export {
  CHANNELS,
  type Channel,
  type Registered,
  describeSource,
  followsReleases,
  followsMain,
  sameSource,
} from "./harness-source.ts";
export {
  commandTimeoutMs,
  PLUGIN_ID,
  type Say,
  UpgradeRequestError,
} from "./harness-command.ts";
export {
  claudeScopedInstalls,
  directoryState,
  refreshScoped,
  type ScopedInstall,
  type ScopedResult,
  scopedInstalls,
} from "./scoped-installs.ts";

export const DEFAULT_SOURCE = "https://github.com/jig-harness/jig.git";

/** The channel a fresh install follows. */
const DEFAULT_CHANNEL: Channel = "stable";

export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface Installed {
  version: string;
  enabled: boolean;
  /** The folder Claude Code loads the plugin from in place, from a local marketplace: no cache copy. */
  inPlace?: string;
}

/** The program that runs each harness: the absolute path a job recorded, else its name on `PATH`. */
export type Programs = Partial<Record<Harness, string>>;

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

function refuseOtherSource(
  harness: Harness,
  registered: Registered,
  requested: string,
  explicit: boolean,
): void {
  if (!explicit || sameSource(registered.location, requested, registered.git))
    return;
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

/**
 * The request for `--source`, `--channel` and `--claude`/`--codex` as given,
 * or `contradictory-request` when they contradict each other.
 */
export function harnessRequest(
  options: { source?: string; channel?: Channel; only?: Harness | null },
  env: NodeJS.ProcessEnv = process.env,
): Outcome<HarnessRequest, "contradictory-request"> {
  const fromEnv = env.JIG_MARKETPLACE;
  const source = options.source ?? (fromEnv || DEFAULT_SOURCE);
  const explicit = options.source !== undefined || Boolean(fromEnv);
  const only = options.only ?? null;
  if (options.channel === undefined)
    return ok({ source, explicit, defaulted: !explicit, only });
  const channelled = atChannel(source, options.channel);
  if (!channelled.ok) return channelled;
  return ok({
    source: channelled.value,
    explicit: true,
    defaulted: false,
    only,
  });
}

/** `source` at `channel`'s ref; refused where a channel cannot apply. */
function atChannel(
  source: string,
  channel: Channel,
): Outcome<string, "contradictory-request"> {
  if (splitSource(source).ref !== undefined)
    return failed(
      "contradictory-request",
      `--channel and a source that names a ref (${source}) contradict each other; give one`,
    );
  if (!isGitAddress(source))
    return failed(
      "contradictory-request",
      `--channel needs a Git address; ${source} is a directory, which has no channels`,
    );
  return ok(`${source}#${channel}`);
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
  /** Claude Code after an upgrade: what became of each project- and local-scope install. */
  scoped?: ScopedResult[];
  /** Claude Code after an upgrade: why the scoped installs could not be inspected or refreshed. */
  scopedError?: string;
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
    const result = outcome(harness, before, after);
    return harness === "claude"
      ? { ...result, ...scopedStep(program, say, result.version) }
      : result;
  });
}

/** Resolve every selected registration before bootstrap permits any writes. */
export function prepareHarnesses(
  request: HarnessRequest,
  say: Say = console.log,
) {
  const selected = request.only ? [request.only] : HARNESSES;
  const plans = selected.flatMap((harness) => {
    const skipped = absent(harness, request, say);
    if (skipped) return [];
    const program = programOf(harness, request);
    const registered = registeredMarketplace(harness, program);
    if (registered)
      refuseOtherSource(harness, registered, request.source, request.explicit);
    const state = installed(harness, program);
    const source =
      registered?.location ??
      (request.defaulted ? defaultChannelSource(say) : request.source);
    say(
      `${harness}: ${state ? `installed ${state.version}` : "fresh install"}; source ${source}`,
    );
    if (harness === "claude") {
      for (const scoped of scopedInstalls(program)) {
        const where = directoryState(scoped.project);
        say(
          `claude: ${scoped.scope} install ${scoped.project}: ${where === "gone" ? "remove stale install record" : where === "present" ? "refresh from its directory" : `leave unchanged (${where})`}`,
        );
      }
    }
    return [{ harness, source, registered, state }];
  });
  if (plans.length === 0)
    throw new UpgradeRequestError("Install a supported agent CLI first");
  return plans;
}

/**
 * The scoped installs' refresh after the user-scope one: a failure here is
 * reported, never the user-scope upgrade's outcome.
 */
function scopedStep(
  program: string,
  say: Say,
  current: string | undefined,
): { scoped: ScopedResult[] } | { scopedError: string } {
  try {
    return { scoped: refreshScoped(program, say, current ?? null) };
  } catch (error) {
    const scopedError = `the project- and local-scope installs of ${PLUGIN_ID} were not refreshed: ${reason(error)}`;
    console.error(`claude: ${scopedError}`);
    return { scopedError };
  }
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
    (result) =>
      result.outcome === "failed" ||
      result.outcome === "missing" ||
      result.scopedError !== undefined ||
      result.scoped?.some((install) => install.outcome === "left"),
  )
    ? 1
    : 0;
}
