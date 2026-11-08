/**
 * The machine file, `$JIG_HOME/dispatch.yaml` (default
 * `~/.jig/dispatch.yaml`): what this machine dispatches and on whose
 * accounts. A repository's own `dispatch` section says what it wants; this
 * file says which repositories this machine starts stages for, which
 * stages, and which subscription accounts it may bill. Nothing a
 * repository holds can widen it.
 *
 * ```yaml
 * repositories:
 *   - path: /home/me/dev/web
 *     stages: [rearm]
 *     followup_since: 2026-10-30T00:00:00Z
 *     owner: true
 * accounts:
 *   - name: work
 *     vendor: claude
 *     config_dir: /home/me/.claude-work
 *     identity: me@example.com
 *     max_per_account: 2
 * interval: 5m
 * wall_backoff: 1h
 * runtime_timeout: 1m
 * workspace_timeout: 50m
 * opens_per_tick: 4
 * receipts_days: 30
 * unclaimed_after: 15m
 * dashboard:
 *   listen: 100.64.0.7:8765
 *   require_token: true     # false only with a loopback listen: a front authenticates
 * records:
 *   shared: forge
 * send: true
 * change_probe: true
 * ```
 *
 * An unknown key anywhere is refused, so a misspelt dial never reads as its
 * default.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isMapping, jigHome } from "../../shared/config-layers.ts";
import { OPEN_LIMIT_MS } from "../../shared/orca-workspace/limits.ts";
import { load } from "../../shared/yaml.ts";
import { isLoopback, type Listen, parseListen } from "./listen.ts";

/** The stages a machine file can enable. */
const MACHINE_STAGES = [
  "rearm",
  "pickup",
  "followup",
  "notify",
  "steer",
] as const;
export type MachineStage = (typeof MACHINE_STAGES)[number];

export interface MachineAccount {
  /** The account's name here, which launch records and walls are keyed by. */
  name: string;
  /**
   * The agent tool the account bills (`claude`, `codex`): it chooses the
   * agent every session on the account runs in. Any name is accepted; one
   * the drive documents no pass command for is reported and never admitted.
   */
  vendor: string;
  /** The account's Orca profile configuration directory (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`). */
  configDir: string;
  /** What the drive's identity resolver reads from that directory: an email address or an account id. */
  identity: string;
  /** Sessions the dispatcher may hold on it at once. */
  maxPerAccount: number;
}

export interface MachineRepository {
  path: string;
  stages: MachineStage[];
  followupSince: string | null;
  /**
   * Whether this host owns the repository's board, notifications, history
   * rows and labels; `true` by default, so a single machine keeps them. A host
   * that does not own a repository another host also dispatches launches,
   * re-arms, re-drives and takes over through the shared records, and writes
   * none of those.
   */
  owner: boolean;
}

/** Where the records another host reads are shared (`records.shared`): the forge, the only medium today. */
const SHARED_MEDIA = ["forge"] as const;
export type SharedMedium = (typeof SHARED_MEDIA)[number];

export interface MachineConfig {
  path: string;
  repositories: MachineRepository[];
  accounts: MachineAccount[];
  intervalMs: number;
  wallBackoffMs: number;
  runtimeTimeoutMs: number;
  workspaceTimeoutMs: number;
  /** Workspace opens per tick, including the reserved notices open. */
  opensPerTick: number;
  receiptsDays: number;
  /** How long a launch the runtime answered as started may go unclaimed by its wrapper before it is stuck (`unclaimed_after`). */
  unclaimedAfterMs: number;
  /** The address `jig dispatch dashboard` listens on (`dashboard.listen`); `null` when the file names none. */
  dashboardListen: Listen | null;
  /** Whether a request to the dashboard needs the token its command prints (`dashboard.require_token`); `true` unless the file says `false`, which only a loopback `listen` accepts. */
  dashboardRequireToken: boolean;
  /** Where the records another host reads are shared (`records.shared`). */
  sharedRecords: SharedMedium;
  /** Whether `jig send` may write a request from this machine (`send`); `true` unless the file says `false`. */
  send: boolean;
  /** Whether the change probe wakes the ticks of repositories that changed on the forge (`change_probe`); `true` unless the file says `false`. */
  changeProbe: boolean;
}

const DEFAULTS = {
  maxPerAccount: 2,
  intervalMs: 5 * 60_000,
  wallBackoffMs: 60 * 60_000,
  runtimeTimeoutMs: 60_000,
  workspaceTimeoutMs: OPEN_LIMIT_MS,
  opensPerTick: 4,
  receiptsDays: 30,
  unclaimedAfterMs: 15 * 60_000,
} as const;

const TOP_KEYS = [
  "repositories",
  "accounts",
  "interval",
  "wall_backoff",
  "runtime_timeout",
  "workspace_timeout",
  "opens_per_tick",
  "receipts_days",
  "unclaimed_after",
  "dashboard",
  "records",
  "send",
  "change_probe",
];
const DASHBOARD_KEYS = ["listen", "require_token"];
const RECORDS_KEYS = ["shared"];
const REPOSITORY_KEYS = ["path", "stages", "followup_since", "owner"];
const ACCOUNT_KEYS = [
  "name",
  "vendor",
  "config_dir",
  "identity",
  "max_per_account",
];

export class MachineConfigError extends Error {
  override name = "MachineConfigError";
}

export function machineConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jigHome(env), "dispatch.yaml");
}

function only(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0)
    throw new MachineConfigError(
      `${where} has unknown key(s): ${unknown.join(", ")} (known: ${allowed.join(", ")})`,
    );
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new MachineConfigError(`${where} must be a nonempty string`);
  return value.trim();
}

/** A path, `~/` expanded; relative paths are refused, since a timer has no working directory to read them against. */
function path(value: unknown, where: string): string {
  const raw = text(value, where);
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded))
    throw new MachineConfigError(`${where} must be an absolute path: ${raw}`);
  return resolve(expanded);
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
/** The longest duration any setting takes: inside the 2,147,483,647 ms a timer holds, which the deadlines of child processes are armed with. */
const MAX_DURATION_MS = 24 * 86_400_000;

/** A duration such as `90s`, `5m` or `1h`, in milliseconds. */
export function duration(value: unknown, where: string): number {
  const match =
    typeof value === "string" ? /^(\d+)\s*([smh])$/.exec(value.trim()) : null;
  const ms = match ? Number(match[1]) * (UNITS[match[2] as string] ?? 0) : 0;
  if (!match || ms <= 0 || ms > MAX_DURATION_MS)
    throw new MachineConfigError(
      `${where} must be a positive duration such as 90s, 5m or 1h, at most 24d`,
    );
  return ms;
}

function optionalDuration(
  value: unknown,
  where: string,
  fallback: number,
): number {
  return value === undefined || value === null
    ? fallback
    : duration(value, where);
}

function count(value: unknown, where: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new MachineConfigError(`${where} must be a positive whole number`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new MachineConfigError(`${where} must be a list`);
  return value;
}

function stages(value: unknown, where: string): MachineStage[] {
  const raw = list(value, where);
  if (
    raw.some((s) => !(MACHINE_STAGES as readonly unknown[]).includes(s)) ||
    new Set(raw).size !== raw.length
  )
    throw new MachineConfigError(
      `${where} must list distinct stages from ${MACHINE_STAGES.join(", ")}`,
    );
  return raw as MachineStage[];
}

function since(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw)))
    throw new MachineConfigError(`${where} must be a date`);
  return new Date(raw).toISOString();
}

function repository(value: unknown, i: number): MachineRepository {
  const where = `repositories[${i}]`;
  if (!isMapping(value))
    throw new MachineConfigError(`${where} must be a mapping`);
  only(value, REPOSITORY_KEYS, where);
  return {
    path: path(value.path, `${where}.path`),
    stages: stages(value.stages, `${where}.stages`),
    followupSince: since(value.followup_since, `${where}.followup_since`),
    owner: flag(value.owner, `${where}.owner`, true),
  };
}

function flag(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean")
    throw new MachineConfigError(`${where} must be true or false`);
  return value;
}

function account(value: unknown, i: number): MachineAccount {
  const where = `accounts[${i}]`;
  if (!isMapping(value))
    throw new MachineConfigError(`${where} must be a mapping`);
  only(value, ACCOUNT_KEYS, where);
  const vendor = text(value.vendor, `${where}.vendor`);
  if (!/^[a-z][a-z0-9-]*$/.test(vendor))
    throw new MachineConfigError(
      `${where}.vendor must be an agent tool's name in lowercase letters, digits and dashes (claude, codex): ${vendor}`,
    );
  const name = text(value.name, `${where}.name`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
    throw new MachineConfigError(
      `${where}.name must be letters, digits, dot, dash or underscore: ${name}`,
    );
  return {
    name,
    vendor,
    configDir: path(value.config_dir, `${where}.config_dir`),
    identity: text(value.identity, `${where}.identity`),
    maxPerAccount: count(
      value.max_per_account,
      `${where}.max_per_account`,
      DEFAULTS.maxPerAccount,
    ),
  };
}

function distinct<T>(items: T[], key: (t: T) => string, what: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) throw new MachineConfigError(`${what} listed twice: ${k}`);
    seen.add(k);
  }
  return items;
}

/** The longest a timer holds: the tick's overall deadline is armed with it. */
const MAX_TIMER_MS = 2_147_483_647;

/** The default workspaces one tick may open, including the notices reservation. */
export const OPENS_PER_TICK = DEFAULTS.opensPerTick;

/**
 * The default `unclaimed_after`. The runtime answers a launch as started
 * once the terminal running the wrapper exists (each call bounded by
 * `runtime_timeout`, a minute by default); the workspace was opened before
 * the call, so its clone and create hook are not in this window. The
 * wrapper's first act is to read its record, read its own process identity
 * and claim the record: seconds on a host under load. Fifteen minutes is
 * many times that, and three ticks at the default interval, so a slow
 * start is never read as a claim that is not coming.
 */
export const UNCLAIMED_AFTER_MS = DEFAULTS.unclaimedAfterMs;

/** What one tick may spend at the file's limits: its workspace opens and eight runtime calls, in milliseconds. */
export function tickBudgetMs(limits: {
  workspaceTimeoutMs: number;
  runtimeTimeoutMs: number;
  opensPerTick?: number;
}): number {
  return (
    (limits.opensPerTick ?? OPENS_PER_TICK) * limits.workspaceTimeoutMs +
    8 * limits.runtimeTimeoutMs
  );
}

/** The least a tick may run before the launcher stops it: several repositories' workspace opens and launches. */
export const MIN_TICK_DEADLINE_MS = 6 * 3600 * 1000;

/**
 * How long the installed launcher lets a tick run: its planning and its
 * launches together, never less than `MIN_TICK_DEADLINE_MS`.
 */
export function tickDeadlineMs(limits: {
  workspaceTimeoutMs: number;
  runtimeTimeoutMs: number;
  opensPerTick?: number;
}): number {
  return Math.max(MIN_TICK_DEADLINE_MS, tickBudgetMs(limits));
}

/** The machine file's values, with defaults. */
function parseMachineConfig(values: unknown, where: string): MachineConfig {
  const config = parseValues(values, where);
  if (
    config.opensPerTick < 2 &&
    config.repositories.some((repo) => repo.stages.includes("notify"))
  )
    throw new MachineConfigError(
      `${where}: opens_per_tick must be at least 2 when notify is enabled, to keep one open for launches beside the notices reservation`,
    );
  if (tickBudgetMs(config) > MAX_TIMER_MS)
    throw new MachineConfigError(
      `${where}: opens_per_tick, workspace_timeout and runtime_timeout together allow a tick longer than 24d (${config.opensPerTick} workspace opens plus 8 runtime calls); lower opens_per_tick or shorten the timeouts`,
    );
  return config;
}

function parseValues(values: unknown, where: string): MachineConfig {
  const top = values ?? {};
  if (!isMapping(top))
    throw new MachineConfigError(`${where} must be a mapping`);
  only(top, TOP_KEYS, where);
  return {
    path: where,
    repositories: distinct(
      list(top.repositories, "repositories").map(repository),
      (r) => r.path,
      "a repository",
    ),
    accounts: distinct(
      distinct(
        distinct(
          list(top.accounts, "accounts").map(account),
          (a) => a.name,
          "an account",
        ),
        (a) => `${a.vendor}:${a.identity.toLowerCase()}`,
        "an account identity",
      ),
      (a) => `${a.vendor}:${a.configDir}`,
      "an account configuration directory",
    ),
    intervalMs: optionalDuration(top.interval, "interval", DEFAULTS.intervalMs),
    wallBackoffMs: optionalDuration(
      top.wall_backoff,
      "wall_backoff",
      DEFAULTS.wallBackoffMs,
    ),
    runtimeTimeoutMs: optionalDuration(
      top.runtime_timeout,
      "runtime_timeout",
      DEFAULTS.runtimeTimeoutMs,
    ),
    workspaceTimeoutMs: optionalDuration(
      top.workspace_timeout,
      "workspace_timeout",
      DEFAULTS.workspaceTimeoutMs,
    ),
    opensPerTick: count(
      top.opens_per_tick,
      "opens_per_tick",
      DEFAULTS.opensPerTick,
    ),
    receiptsDays: count(
      top.receipts_days,
      "receipts_days",
      DEFAULTS.receiptsDays,
    ),
    unclaimedAfterMs: optionalDuration(
      top.unclaimed_after,
      "unclaimed_after",
      DEFAULTS.unclaimedAfterMs,
    ),
    dashboardListen: dashboard(top.dashboard),
    dashboardRequireToken: dashboardRequireToken(top.dashboard),
    sharedRecords: records(top.records),
    send: flag(top.send, "send", true),
    changeProbe: flag(top.change_probe, "change_probe", true),
  };
}

/** Where the shared records live: `forge` when the file names none; a medium this version does not know is refused. */
function records(value: unknown): SharedMedium {
  if (value === undefined || value === null) return "forge";
  if (!isMapping(value))
    throw new MachineConfigError("records must be a mapping");
  only(value, RECORDS_KEYS, "records");
  const shared = value.shared;
  if (shared === undefined || shared === null) return "forge";
  if (!(SHARED_MEDIA as readonly unknown[]).includes(shared))
    throw new MachineConfigError(
      `records.shared must be one of ${SHARED_MEDIA.join(", ")}: ${String(shared)}`,
    );
  return shared as SharedMedium;
}

/** The dashboard's address; `null` when the file names none. */
function dashboard(value: unknown): Listen | null {
  if (value === undefined || value === null) return null;
  if (!isMapping(value))
    throw new MachineConfigError("dashboard must be a mapping");
  only(value, DASHBOARD_KEYS, "dashboard");
  if (value.listen === undefined || value.listen === null) return null;
  try {
    return parseListen(text(value.listen, "dashboard.listen"));
  } catch (error) {
    if (error instanceof MachineConfigError) throw error;
    throw new MachineConfigError(
      `dashboard.listen: ${(error as Error).message}`,
    );
  }
}

/** Whether the dashboard demands its token. Turning it off is accepted only where nothing but a front on this host can reach the port. */
function dashboardRequireToken(value: unknown): boolean {
  const listen = dashboard(value);
  const required = flag(
    isMapping(value) ? value.require_token : undefined,
    "dashboard.require_token",
    true,
  );
  if (!required && (listen === null || !isLoopback(listen)))
    throw new MachineConfigError(
      "dashboard.require_token: false needs a loopback dashboard.listen (127.0.0.1 or ::1), since only a front on this host that authenticates the person may reach a page with no token",
    );
  return required;
}

/** The machine file, or `null` when there is none; a file that does not read throws. */
export function readMachineConfig(
  file: string = machineConfigPath(),
): MachineConfig | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MachineConfigError(
      `${file} cannot be read: ${(error as Error).message}`,
    );
  }
  let values: unknown;
  try {
    values = load(raw);
  } catch (error) {
    throw new MachineConfigError(
      `${file} is not YAML: ${(error as Error).message.split("\n")[0]}`,
    );
  }
  try {
    return parseMachineConfig(values, file);
  } catch (error) {
    throw new MachineConfigError(`${file}: ${(error as Error).message}`);
  }
}

/** The machine file's entry for a repository path, if any. */
export function machineRepository(
  config: MachineConfig | null,
  repoPath: string,
): MachineRepository | null {
  return config?.repositories.find((r) => r.path === resolve(repoPath)) ?? null;
}
