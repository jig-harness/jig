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
 * (project and local scope). An upgrade refreshes each from its directory,
 * and drops from Claude Code's install record each whose directory no longer
 * exists, since no `claude` command can reach it there.
 *
 * Every command that changes something is printed before it runs. It writes
 * only the harnesses' own plugin settings and caches; it never touches a
 * repository's files. Each tool command is limited to
 * `JIG_SETUP_TIMEOUT_SECONDS` (default 300), so a stalled fetch fails rather
 * than hangs.
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JigError } from "../shared/errors.ts";
import { failed, ok, type Outcome } from "../shared/outcome.ts";

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

const PLUGIN = "jig";
const MARKETPLACE = "jig";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
export const DEFAULT_SOURCE = "https://github.com/jig-harness/jig.git";

/** A request that cannot be carried out as given: the command line contradicts itself. */
export class UpgradeRequestError extends JigError<"contradictory-request"> {
  override name = "UpgradeRequestError";
  constructor(reason: string, options?: { cause?: unknown }) {
    super("contradictory-request", reason, options);
  }
}

/**
 * A harness that could not be used: a tool command that failed, stalled or
 * answered something unreadable, a named harness not on `PATH`, or a
 * marketplace registered from a source other than the one asked for.
 */
class HarnessError extends JigError<"harness-unusable"> {
  override name = "HarnessError";
  constructor(reason: string, options?: { cause?: unknown }) {
    super("harness-unusable", reason, options);
  }
}

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

/** Runs one tool command, in `cwd` when given; given `say`, prints it first. */
function run(command: string, args: string[], say?: Say, cwd?: string): string {
  say?.(
    `$ ${cwd === undefined ? "" : `(cd ${cwd}) `}${[command, ...args].join(" ")}`,
  );
  const timeout = commandTimeoutMs();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    ...(cwd === undefined ? {} : { cwd }),
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

/** A Claude Code install of the plugin made for one directory. */
export interface ScopedInstall {
  scope: "project" | "local";
  /** The directory it was installed for; it may since have been deleted. */
  project: string;
  version: string;
  enabled: boolean;
}

/** The project- and local-scope installs from `claude plugin list --json`. */
export function claudeScopedInstalls(list: unknown): ScopedInstall[] {
  if (!Array.isArray(list))
    throw new HarnessError(
      "claude plugin list --json did not print a list of plugins",
    );
  return list.flatMap((entry): ScopedInstall[] =>
    entry?.id === PLUGIN_ID &&
    (entry.scope === "project" || entry.scope === "local") &&
    typeof entry.projectPath === "string" &&
    entry.projectPath !== "" &&
    typeof entry.version === "string"
      ? [
          {
            scope: entry.scope,
            project: entry.projectPath,
            version: entry.version,
            enabled: entry.enabled === true,
          },
        ]
      : [],
  );
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

/** Claude Code's project- and local-scope installs of the plugin. */
export function scopedInstalls(program = "claude"): ScopedInstall[] {
  return claudeScopedInstalls(json(program, ["plugin", "list", "--json"]));
}

/**
 * Whether a scoped install's directory is there: `present`, `gone`, or why
 * neither can be said (a file in its place, a directory that cannot be read).
 */
export function directoryState(path: string): "present" | "gone" | string {
  try {
    return statSync(path).isDirectory()
      ? "present"
      : `${path} is not a directory`;
  } catch (error) {
    // ENOTDIR means a parent is a file, which says nothing of this directory.
    if (code(error) === "ENOENT") return "gone";
    return `${path} cannot be read: ${reason(error)}`;
  }
}

/**
 * Claude Code's record of what it installed, in its plugins directory:
 * `CLAUDE_CODE_PLUGIN_CACHE_DIR` where set, else under its configuration directory.
 */
function claudeInstallRecord(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR ||
      join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plugins"),
    "installed_plugins.json",
  );
}

/** The form of Claude Code's install record this release can edit. */
const RECORD_VERSION = 2;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The record's entries for the plugin, or why this release must not edit it. */
function recordEntries(
  record: string,
): { data: { plugins: Record<string, unknown> }; entries: unknown[] } | string {
  let data: { version?: unknown; plugins?: Record<string, unknown> };
  try {
    data = JSON.parse(readFileSync(record, "utf8"));
  } catch (error) {
    return `${record} cannot be read: ${reason(error)}`;
  }
  const entries = data?.plugins?.[PLUGIN_ID];
  if (data?.version !== RECORD_VERSION || !Array.isArray(entries))
    return `${record} is not in the form this release edits (version ${RECORD_VERSION}, with a ${PLUGIN_ID} list)`;
  return { data: data as { plugins: Record<string, unknown> }, entries };
}

/** The key that names one scoped install in the record and in the list. */
const scopedKey = (scope: unknown, project: unknown) =>
  JSON.stringify([scope, project]);

/**
 * Drops `gone` from Claude Code's install record, each only while its
 * directory is still missing, replacing the record whole through a file
 * beside it: the keys it dropped, or why it left the record as it was.
 */
function pruneRecord(
  link: string,
  gone: readonly ScopedInstall[],
): Set<string> | string {
  let record: string;
  let before: ReturnType<typeof statSync>;
  try {
    // A record kept as a link is written where the link points.
    record = realpathSync(link);
    before = statSync(record);
  } catch (error) {
    return `${link} cannot be read: ${reason(error)}`;
  }
  const read = recordEntries(record);
  if (typeof read === "string") return read;
  const wanted = new Set(gone.map((i) => scopedKey(i.scope, i.project)));
  const dropped = new Set<string>();
  const kept = read.entries.filter((entry) => {
    const { scope, projectPath } = (entry ?? {}) as Record<string, unknown>;
    const key = scopedKey(scope, projectPath);
    const drop =
      wanted.has(key) && directoryState(String(projectPath)) === "gone";
    if (drop) dropped.add(key);
    return !drop;
  });
  if (dropped.size === 0) return dropped;
  const { plugins } = read.data;
  if (kept.length === 0) delete plugins[PLUGIN_ID];
  else plugins[PLUGIN_ID] = kept;
  const next = `${record}.jig-${process.pid}`;
  try {
    writeFileSync(next, `${JSON.stringify(read.data, null, 2)}\n`, {
      mode: Number(before.mode) & 0o777,
    });
    // Claude Code writes this record too; one it rewrote meanwhile is left
    // for the next upgrade rather than overwritten. The window that remains,
    // between this check and the rename, can still lose its write.
    const now = statSync(record);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      rmSync(next, { force: true });
      return `${record} changed while it was being edited; the next upgrade tries again`;
    }
    renameSync(next, record);
  } catch (error) {
    rmSync(next, { force: true });
    return `${record} cannot be written: ${reason(error)}`;
  }
  return dropped;
}

/**
 * What became of one scoped install in an upgrade: `refreshed` or
 * `unchanged` by `claude plugin update` from its directory, `removed` from
 * the install record when its directory is gone, `left` as it was when
 * neither could be done safely (`detail` says why).
 */
export interface ScopedResult {
  scope: ScopedInstall["scope"];
  project: string;
  before: string;
  version?: string;
  outcome: "refreshed" | "unchanged" | "removed" | "left";
  detail: string;
}

function scopedResult(
  install: ScopedInstall,
  outcome: ScopedResult["outcome"],
  detail: string,
  /** Null for an install that is gone. */
  version: string | null = install.version,
): ScopedResult {
  return {
    scope: install.scope,
    project: install.project,
    before: install.version,
    ...(version === null ? {} : { version }),
    outcome,
    detail,
  };
}

/** Removes each install whose directory is gone from the record; what became of each. */
function removeGone(
  gone: readonly ScopedInstall[],
  record: string,
  say: Say,
): ScopedResult[] {
  if (gone.length === 0) return [];
  say(
    `$ remove ${gone.length} ${PLUGIN_ID} install${gone.length === 1 ? "" : "s"} whose directory no longer exists from ${record}`,
  );
  const dropped = pruneRecord(record, gone);
  return gone.map((install) =>
    typeof dropped === "string"
      ? scopedResult(install, "left", dropped)
      : dropped.has(scopedKey(install.scope, install.project))
        ? scopedResult(
            install,
            "removed",
            "its directory no longer exists",
            null,
          )
        : scopedResult(install, "left", `${record} no longer lists it as gone`),
  );
}

/** What each install `claude plugin update` ran for is at now. */
function settled(
  program: string,
  updated: readonly ScopedInstall[],
): ScopedResult[] {
  if (updated.length === 0) return [];
  let listed: ScopedInstall[];
  try {
    listed = scopedInstalls(program);
  } catch (error) {
    return updated.map((install) =>
      scopedResult(
        install,
        "left",
        `updated, but its version cannot be read back: ${reason(error)}`,
      ),
    );
  }
  const now = new Map(
    listed.map((entry) => [
      scopedKey(entry.scope, entry.project),
      entry.version,
    ]),
  );
  return updated.map((install) => {
    const version = now.get(scopedKey(install.scope, install.project));
    if (version === undefined)
      return scopedResult(
        install,
        "left",
        "claude plugin update finished, but claude plugin list no longer lists it",
      );
    return version === install.version
      ? scopedResult(install, "unchanged", `already at ${version}`)
      : scopedResult(
          install,
          "refreshed",
          `${install.version} → ${version}`,
          version,
        );
  });
}

/**
 * Refreshes each of Claude Code's project- and local-scope installs from its
 * directory, unless it is already at `current` (the user-scope version), and
 * removes each whose directory is gone; says what became of each that
 * changed or was left.
 */
export function refreshScoped(
  program: string,
  say: Say,
  current: string | null = null,
  record: string = claudeInstallRecord(),
): ScopedResult[] {
  const left: ScopedResult[] = [];
  const gone: ScopedInstall[] = [];
  const updated: ScopedInstall[] = [];
  for (const install of scopedInstalls(program)) {
    const where = directoryState(install.project);
    if (where === "gone") gone.push(install);
    else if (where !== "present")
      left.push(scopedResult(install, "left", where));
    else if (install.version === current) updated.push(install);
    else
      try {
        run(
          program,
          ["plugin", "update", PLUGIN_ID, "--scope", install.scope],
          say,
          install.project,
        );
        updated.push(install);
      } catch (error) {
        left.push(scopedResult(install, "left", reason(error)));
      }
  }
  const results = [
    ...left,
    ...removeGone(gone, record, say),
    ...settled(program, updated),
  ];
  for (const result of results)
    if (result.outcome !== "unchanged")
      say(
        `claude: ${PLUGIN_ID} ${result.before} for ${result.project} (${result.scope} scope): ${result.outcome}, ${result.detail}`,
      );
  return results;
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
    (result) => result.outcome === "failed" || result.outcome === "missing",
  )
    ? 1
    : 0;
}
