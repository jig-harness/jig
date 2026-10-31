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
 * receipts_days: 30
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

/** The stages a machine file can enable; only `rearm` starts anything yet. */
const MACHINE_STAGES = [
  "rearm",
  "pickup",
  "followup",
  "notify",
  "steer",
] as const;
export type MachineStage = (typeof MACHINE_STAGES)[number];

export type AccountVendor = "claude" | "codex";

export interface MachineAccount {
  /** The account's name here, which launch records and walls are keyed by. */
  name: string;
  vendor: AccountVendor;
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
}

export interface MachineConfig {
  path: string;
  repositories: MachineRepository[];
  accounts: MachineAccount[];
  intervalMs: number;
  wallBackoffMs: number;
  runtimeTimeoutMs: number;
  workspaceTimeoutMs: number;
  receiptsDays: number;
}

const DEFAULTS = {
  maxPerAccount: 2,
  intervalMs: 5 * 60_000,
  wallBackoffMs: 60 * 60_000,
  runtimeTimeoutMs: 60_000,
  workspaceTimeoutMs: OPEN_LIMIT_MS,
  receiptsDays: 30,
} as const;

const TOP_KEYS = [
  "repositories",
  "accounts",
  "interval",
  "wall_backoff",
  "runtime_timeout",
  "workspace_timeout",
  "receipts_days",
];
const REPOSITORY_KEYS = ["path", "stages", "followup_since"];
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
  };
}

function account(value: unknown, i: number): MachineAccount {
  const where = `accounts[${i}]`;
  if (!isMapping(value))
    throw new MachineConfigError(`${where} must be a mapping`);
  only(value, ACCOUNT_KEYS, where);
  const vendor = text(value.vendor, `${where}.vendor`);
  if (vendor !== "claude" && vendor !== "codex")
    throw new MachineConfigError(`${where}.vendor must be claude or codex`);
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

/** What one tick may spend at the file's limits: two workspace opens and eight runtime calls, in milliseconds. */
export function tickBudgetMs(limits: {
  workspaceTimeoutMs: number;
  runtimeTimeoutMs: number;
}): number {
  return 2 * limits.workspaceTimeoutMs + 8 * limits.runtimeTimeoutMs;
}

/** The machine file's values, with defaults. */
function parseMachineConfig(values: unknown, where: string): MachineConfig {
  const config = parseValues(values, where);
  if (tickBudgetMs(config) > MAX_TIMER_MS)
    throw new MachineConfigError(
      `${where}: workspace_timeout and runtime_timeout together allow a tick longer than 24d (2 workspace opens plus 8 runtime calls); shorten them`,
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
    receiptsDays: count(
      top.receipts_days,
      "receipts_days",
      DEFAULTS.receiptsDays,
    ),
  };
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
