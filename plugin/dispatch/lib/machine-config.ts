/**
 * The machine file, `$JIG_HOME/dispatch.yaml` (default
 * `~/.jig/dispatch.yaml`): what this machine dispatches and on whose
 * accounts. A repository's own `dispatch` section says what it wants; this
 * file says which repositories this machine starts stages for, which
 * stages, and which subscription accounts it may bill. Nothing a
 * repository holds can widen it.
 *
 * ```yaml
 * serve_defaults:          # a tracker namespace's repository for items no repository label places
 *   linear:ENG: /home/me/dev/web
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
 * followup_opens_per_tick: 2
 * followup_concurrency: 2
 * receipts_days: 30
 * unclaimed_after: 15m
 * failures:
 *   backoff: 2m
 *   backoff_max: 1h
 *   notify_after: 3
 * dashboard:
 *   listen: 100.64.0.7:8765
 *   require_token: true     # false only with a loopback listen: a front authenticates
 *   allowed_hosts: []       # host names that front forwards under (tokenless only)
 * records:
 *   shared: forge
 * send: true
 * change_probe: true
 * load:
 *   enforce: false          # the gauges' lines and reservations: load-config.ts
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
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { load } from "../../shared/yaml.ts";
import { FAILURE_DEFAULTS, type FailureSettings } from "./failures.ts";
import { isLoopback, type Listen, parseListen } from "./listen.ts";
import { type LoadSettings, loadSettings } from "./load-config.ts";
import { type ServedPerson, servedPeople } from "./serve-config.ts";

/** The stages a machine file can enable. */
const MACHINE_STAGES = [
  "rearm",
  "pickup",
  "followup",
  "notify",
  "steer",
  "steward",
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
  steward?: { enabled: boolean; everyMs: number };
  path: string;
  /** People authorized by this host, never by a repository overlay. */
  serve?: ServedPerson[];
  /**
   * The repository that starts the served items no repository label places,
   * by tracker namespace (lower case) to checkout path: one per namespace,
   * so two repositories sharing a tracker never both start such an item.
   */
  serveDefaults?: Record<string, string>;
  repositories: MachineRepository[];
  accounts: MachineAccount[];
  intervalMs: number;
  wallBackoffMs: number;
  runtimeTimeoutMs: number;
  workspaceTimeoutMs: number;
  /** Workspace opens per tick, including the reserved notices open. */
  opensPerTick: number;
  /** The follow-ups' own workspace opens per tick, beside `opensPerTick` (`followup_opens_per_tick`). */
  followupOpensPerTick: number;
  /** How many follow-up passes may run on the host at once (`followup_concurrency`). */
  followupConcurrency: number;
  receiptsDays: number;
  /** How long a launch the runtime answered as started may go unclaimed by its wrapper before it is stuck (`unclaimed_after`). */
  unclaimedAfterMs: number;
  /** How the tick backs off an action that keeps failing, and when it tells a person (`failures`); the defaults when absent. */
  failures?: FailureSettings;
  /** The address `jig dispatch dashboard` listens on (`dashboard.listen`); `null` when the file names none. */
  dashboardListen: Listen | null;
  /** Whether a request to the dashboard needs the token its command prints (`dashboard.require_token`); `true` unless the file says `false`, which only a loopback `listen` accepts. */
  dashboardRequireToken: boolean;
  /** The host names a front forwards under (`dashboard.allowed_hosts`), lower-cased; empty unless the file lists some. */
  dashboardAllowedHosts: string[];
  /** Where the records another host reads are shared (`records.shared`). */
  sharedRecords: SharedMedium;
  /** Whether `jig send` may write a request from this machine (`send`); `true` unless the file says `false`. */
  send: boolean;
  /** Whether the change probe wakes the ticks of repositories that changed on the forge (`change_probe`); `true` unless the file says `false`. */
  changeProbe: boolean;
  /** The host's gauges' lines, the kinds' default reservations and whether the load factor holds launches (`load`). */
  load: LoadSettings;
}

const DEFAULTS = {
  maxPerAccount: 2,
  intervalMs: 5 * 60_000,
  wallBackoffMs: 60 * 60_000,
  runtimeTimeoutMs: 60_000,
  workspaceTimeoutMs: OPEN_LIMIT_MS,
  opensPerTick: 4,
  followupOpensPerTick: 2,
  followupConcurrency: 2,
  receiptsDays: 30,
  unclaimedAfterMs: 15 * 60_000,
} as const;

const TOP_KEYS = [
  "steward",
  "serve",
  "serve_defaults",
  "repositories",
  "accounts",
  "interval",
  "wall_backoff",
  "runtime_timeout",
  "workspace_timeout",
  "opens_per_tick",
  "followup_opens_per_tick",
  "followup_concurrency",
  "receipts_days",
  "unclaimed_after",
  "failures",
  "dashboard",
  "records",
  "send",
  "change_probe",
  "load",
];
const DASHBOARD_KEYS = ["listen", "require_token", "allowed_hosts"];
const FAILURES_KEYS = ["backoff", "backoff_max", "notify_after"];
const RECORDS_KEYS = ["shared"];
const REPOSITORY_KEYS = ["path", "stages", "followup_since", "owner"];
const ACCOUNT_KEYS = [
  "name",
  "vendor",
  "config_dir",
  "identity",
  "max_per_account",
];

/**
 * Why the machine file, or one of its values, is refused: `unreadable` for a
 * file that cannot be read or is not YAML, `invalid` for a value that does
 * not validate. The reason names the file and the setting.
 */
export type MachineConfigCode = "unreadable" | "invalid";

/** A value read from the machine file, or why it does not validate. */
type Checked<T> = Outcome<T, "invalid">;

function invalid(reason: string): Checked<never> {
  return failed("invalid", reason);
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
): Checked<true> {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  return unknown.length > 0
    ? invalid(
        `${where} has unknown key(s): ${unknown.join(", ")} (known: ${allowed.join(", ")})`,
      )
    : ok(true);
}

function text(value: unknown, where: string): Checked<string> {
  if (typeof value !== "string" || value.trim() === "")
    return invalid(`${where} must be a nonempty string`);
  return ok(value.trim());
}

/** A path, `~/` expanded; relative paths are refused, since a timer has no working directory to read them against. */
function path(value: unknown, where: string): Checked<string> {
  const raw = text(value, where);
  if (!raw.ok) return raw;
  const expanded = raw.value.startsWith("~/")
    ? join(homedir(), raw.value.slice(2))
    : raw.value;
  if (!isAbsolute(expanded))
    return invalid(`${where} must be an absolute path: ${raw.value}`);
  return ok(resolve(expanded));
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
/** The longest duration any setting takes: inside the 2,147,483,647 ms a timer holds, which the deadlines of child processes are armed with. */
const MAX_DURATION_MS = 24 * 86_400_000;

/** A duration such as `90s`, `5m` or `1h`, in milliseconds; `invalid` names `where` when it is not one. */
export function duration(value: unknown, where: string): Checked<number> {
  const match =
    typeof value === "string" ? /^(\d+)\s*([smh])$/.exec(value.trim()) : null;
  const ms = match ? Number(match[1]) * (UNITS[match[2] as string] ?? 0) : 0;
  if (!match || ms <= 0 || ms > MAX_DURATION_MS)
    return invalid(
      `${where} must be a positive duration such as 90s, 5m or 1h, at most 24d`,
    );
  return ok(ms);
}

function optionalDuration(
  value: unknown,
  where: string,
  fallback: number,
): Checked<number> {
  return value === undefined || value === null
    ? ok(fallback)
    : duration(value, where);
}

function count(
  value: unknown,
  where: string,
  fallback: number,
): Checked<number> {
  if (value === undefined || value === null) return ok(fallback);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return invalid(`${where} must be a positive whole number`);
  return ok(value);
}

function list(value: unknown, where: string): Checked<unknown[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return invalid(`${where} must be a list`);
  return ok(value);
}

/** Each item read in turn; the first that does not validate. */
function each<T>(
  items: unknown[],
  read: (item: unknown, i: number) => Checked<T>,
): Checked<T[]> {
  const out: T[] = [];
  for (const [i, item] of items.entries()) {
    const one = read(item, i);
    if (!one.ok) return one;
    out.push(one.value);
  }
  return ok(out);
}

function stages(value: unknown, where: string): Checked<MachineStage[]> {
  const raw = list(value, where);
  if (!raw.ok) return raw;
  if (
    raw.value.some(
      (s) => !(MACHINE_STAGES as readonly unknown[]).includes(s),
    ) ||
    new Set(raw.value).size !== raw.value.length
  )
    return invalid(
      `${where} must list distinct stages from ${MACHINE_STAGES.join(", ")}`,
    );
  return ok(raw.value as MachineStage[]);
}

function since(value: unknown, where: string): Checked<string | null> {
  if (value === undefined || value === null) return ok(null);
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw)))
    return invalid(`${where} must be a date`);
  return ok(new Date(raw).toISOString());
}

function repository(value: unknown, i: number): Checked<MachineRepository> {
  const where = `repositories[${i}]`;
  if (!isMapping(value)) return invalid(`${where} must be a mapping`);
  const known = only(value, REPOSITORY_KEYS, where);
  if (!known.ok) return known;
  const repoPath = path(value.path, `${where}.path`);
  if (!repoPath.ok) return repoPath;
  const enabled = stages(value.stages, `${where}.stages`);
  if (!enabled.ok) return enabled;
  const followupSince = since(value.followup_since, `${where}.followup_since`);
  if (!followupSince.ok) return followupSince;
  const owner = flag(value.owner, `${where}.owner`, true);
  if (!owner.ok) return owner;
  return ok({
    path: repoPath.value,
    stages: enabled.value,
    followupSince: followupSince.value,
    owner: owner.value,
  });
}

function flag(
  value: unknown,
  where: string,
  fallback: boolean,
): Checked<boolean> {
  if (value === undefined || value === null) return ok(fallback);
  if (typeof value !== "boolean")
    return invalid(`${where} must be true or false`);
  return ok(value);
}

function account(value: unknown, i: number): Checked<MachineAccount> {
  const where = `accounts[${i}]`;
  if (!isMapping(value)) return invalid(`${where} must be a mapping`);
  const known = only(value, ACCOUNT_KEYS, where);
  if (!known.ok) return known;
  const vendor = text(value.vendor, `${where}.vendor`);
  if (!vendor.ok) return vendor;
  if (!/^[a-z][a-z0-9-]*$/.test(vendor.value))
    return invalid(
      `${where}.vendor must be an agent tool's name in lowercase letters, digits and dashes (claude, codex): ${vendor.value}`,
    );
  const name = text(value.name, `${where}.name`);
  if (!name.ok) return name;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name.value))
    return invalid(
      `${where}.name must be letters, digits, dot, dash or underscore: ${name.value}`,
    );
  const configDir = path(value.config_dir, `${where}.config_dir`);
  if (!configDir.ok) return configDir;
  const identity = text(value.identity, `${where}.identity`);
  if (!identity.ok) return identity;
  const maxPerAccount = count(
    value.max_per_account,
    `${where}.max_per_account`,
    DEFAULTS.maxPerAccount,
  );
  if (!maxPerAccount.ok) return maxPerAccount;
  return ok({
    name: name.value,
    vendor: vendor.value,
    configDir: configDir.value,
    identity: identity.value,
    maxPerAccount: maxPerAccount.value,
  });
}

function distinct<T>(
  items: T[],
  key: (t: T) => string,
  what: string,
): Checked<T[]> {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) return invalid(`${what} listed twice: ${k}`);
    seen.add(k);
  }
  return ok(items);
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

/** The default workspaces the follow-ups' own lane may open in one tick. */
const FOLLOWUP_OPENS_PER_TICK = DEFAULTS.followupOpensPerTick;

/** The limits a tick's budget is calculated from. */
interface TickLimits {
  workspaceTimeoutMs: number;
  runtimeTimeoutMs: number;
  opensPerTick?: number;
  followupOpensPerTick?: number;
}

/** What one tick may spend at the file's limits: its workspace opens, the follow-ups' lane's among them, and eight runtime calls, in milliseconds. */
export function tickBudgetMs(limits: TickLimits): number {
  const opens =
    (limits.opensPerTick ?? OPENS_PER_TICK) +
    (limits.followupOpensPerTick ?? FOLLOWUP_OPENS_PER_TICK);
  return opens * limits.workspaceTimeoutMs + 8 * limits.runtimeTimeoutMs;
}

/** The least a tick may run before the launcher stops it: several repositories' workspace opens and launches. */
export const MIN_TICK_DEADLINE_MS = 6 * 3600 * 1000;

/**
 * How long the installed launcher lets a tick run: its planning and its
 * launches together, never less than `MIN_TICK_DEADLINE_MS`.
 */
export function tickDeadlineMs(limits: TickLimits): number {
  return Math.max(MIN_TICK_DEADLINE_MS, tickBudgetMs(limits));
}

/** The machine file's values, with defaults. */
function parseMachineConfig(
  values: unknown,
  where: string,
): Checked<MachineConfig> {
  const parsed = parseValues(values, where);
  if (!parsed.ok) return parsed;
  const config = parsed.value;
  if (
    config.opensPerTick < 2 &&
    config.repositories.some((repo) => repo.stages.includes("notify"))
  )
    return invalid(
      `${where}: opens_per_tick must be at least 2 when notify is enabled, to keep one open for launches beside the notices reservation`,
    );
  if (tickBudgetMs(config) > MAX_TIMER_MS) {
    // The lane's opens alone pushed the tick past the limit: name its field.
    const lane =
      tickBudgetMs({ ...config, followupOpensPerTick: 0 }) <= MAX_TIMER_MS;
    return invalid(
      lane
        ? `${where}: followup_opens_per_tick ${config.followupOpensPerTick} pushes a tick past 24d (${config.opensPerTick + config.followupOpensPerTick} workspace opens plus 8 runtime calls at workspace_timeout and runtime_timeout); lower followup_opens_per_tick`
        : `${where}: opens_per_tick, workspace_timeout and runtime_timeout together allow a tick longer than 24d (${config.opensPerTick} workspace opens, ${config.followupOpensPerTick} more from followup_opens_per_tick, plus 8 runtime calls); lower opens_per_tick or shorten the timeouts`,
    );
  }
  return ok(config);
}

/** The repositories, each path listed once. */
function repositories(value: unknown): Checked<MachineRepository[]> {
  const raw = list(value, "repositories");
  if (!raw.ok) return raw;
  const read = each(raw.value, repository);
  if (!read.ok) return read;
  return distinct(read.value, (r) => r.path, "a repository");
}

/** `linear:<team>`, or `jira:<site>:<project>` where the site is the https URL, its own colons kept. */
function isTrackerNamespace(key: string): boolean {
  if (/\s/.test(key)) return false;
  if (key.startsWith("linear:")) {
    const team = key.slice("linear:".length);
    return team !== "" && !team.includes(":");
  }
  if (!key.startsWith("jira:")) return false;
  const rest = key.slice("jira:".length);
  const split = rest.lastIndexOf(":");
  if (split < 0) return false;
  const site = rest.slice(0, split);
  const project = rest.slice(split + 1);
  return /^https:\/\/[^/:]+(:\d+)?$/.test(site) && project !== "";
}

/**
 * `serve_defaults`: each tracker namespace's default repository, a checkout
 * listed under `repositories`. A namespace is written once, whatever its case.
 */
function serveDefaults(
  value: unknown,
  listed: readonly MachineRepository[],
): Checked<Record<string, string>> {
  if (value === undefined || value === null) return ok({});
  if (!isMapping(value)) return invalid("serve_defaults must be a mapping");
  const out: Record<string, string> = {};
  for (const [team, raw] of Object.entries(value)) {
    const where = `serve_defaults.${team}`;
    const checkout = path(raw, where);
    if (!checkout.ok) return checkout;
    if (!listed.some((r) => r.path === checkout.value))
      return invalid(
        `${where} must be a repository listed under repositories: ${checkout.value}`,
      );
    const key = team.trim().toLowerCase();
    if (!isTrackerNamespace(key))
      return invalid(
        `${where} must name a tracker namespace as linear:<team> or jira:<site>:<project>`,
      );
    if (key in out)
      return invalid(`serve_defaults lists a tracker namespace twice: ${team}`);
    out[key] = checkout.value;
  }
  return ok(out);
}

/** The accounts, each name, identity and configuration directory listed once. */
function accounts(value: unknown): Checked<MachineAccount[]> {
  const raw = list(value, "accounts");
  if (!raw.ok) return raw;
  const read = each(raw.value, account);
  if (!read.ok) return read;
  const named = distinct(read.value, (a) => a.name, "an account");
  if (!named.ok) return named;
  const identities = distinct(
    named.value,
    (a) => `${a.vendor}:${a.identity.toLowerCase()}`,
    "an account identity",
  );
  if (!identities.ok) return identities;
  return distinct(
    identities.value,
    (a) => `${a.vendor}:${a.configDir}`,
    "an account configuration directory",
  );
}

function parseValues(values: unknown, where: string): Checked<MachineConfig> {
  const top = values ?? {};
  if (!isMapping(top)) return invalid(`${where} must be a mapping`);
  const known = only(top, TOP_KEYS, where);
  if (!known.ok) return known;
  const serve = servedPeople(top.serve);
  if (!serve.ok) return serve;
  const repos = repositories(top.repositories);
  if (!repos.ok) return repos;
  const defaults = serveDefaults(top.serve_defaults, repos.value);
  if (!defaults.ok) return defaults;
  const accountList = accounts(top.accounts);
  if (!accountList.ok) return accountList;
  const timing = limits(top);
  if (!timing.ok) return timing;
  const shared = surfaces(top);
  if (!shared.ok) return shared;
  const host = loadSettings(top.load);
  if (!host.ok) return host;
  const steward = stewardSettings(top.steward);
  if (!steward.ok) return steward;
  return ok({
    path: where,
    serve: serve.value,
    serveDefaults: defaults.value,
    repositories: repos.value,
    accounts: accountList.value,
    ...timing.value,
    ...shared.value,
    load: host.value,
    steward: steward.value,
  });
}

function stewardSettings(
  value: unknown,
): Checked<{ enabled: boolean; everyMs: number }> {
  if (value === undefined || value === null)
    return ok({ enabled: false, everyMs: 20 * 60_000 });
  if (!isMapping(value)) return invalid("steward must be a mapping");
  const known = only(value, ["enabled", "every"], "steward");
  if (!known.ok) return known;
  const enabled = flag(value.enabled, "steward.enabled", false);
  if (!enabled.ok) return enabled;
  const every = optionalDuration(value.every, "steward.every", 20 * 60_000);
  if (!every.ok) return every;
  return ok({ enabled: enabled.value, everyMs: every.value });
}

/** The tick's interval, backoff, timeouts, opens and retention, with defaults. */
function limits(
  top: Record<string, unknown>,
): Checked<
  Pick<
    MachineConfig,
    | "intervalMs"
    | "wallBackoffMs"
    | "runtimeTimeoutMs"
    | "workspaceTimeoutMs"
    | "opensPerTick"
    | "followupOpensPerTick"
    | "followupConcurrency"
    | "receiptsDays"
    | "unclaimedAfterMs"
  >
> {
  const intervalMs = optionalDuration(
    top.interval,
    "interval",
    DEFAULTS.intervalMs,
  );
  if (!intervalMs.ok) return intervalMs;
  const wallBackoffMs = optionalDuration(
    top.wall_backoff,
    "wall_backoff",
    DEFAULTS.wallBackoffMs,
  );
  if (!wallBackoffMs.ok) return wallBackoffMs;
  const runtimeTimeoutMs = optionalDuration(
    top.runtime_timeout,
    "runtime_timeout",
    DEFAULTS.runtimeTimeoutMs,
  );
  if (!runtimeTimeoutMs.ok) return runtimeTimeoutMs;
  const workspaceTimeoutMs = optionalDuration(
    top.workspace_timeout,
    "workspace_timeout",
    DEFAULTS.workspaceTimeoutMs,
  );
  if (!workspaceTimeoutMs.ok) return workspaceTimeoutMs;
  const opensPerTick = count(
    top.opens_per_tick,
    "opens_per_tick",
    DEFAULTS.opensPerTick,
  );
  if (!opensPerTick.ok) return opensPerTick;
  const followupOpensPerTick = count(
    top.followup_opens_per_tick,
    "followup_opens_per_tick",
    DEFAULTS.followupOpensPerTick,
  );
  if (!followupOpensPerTick.ok) return followupOpensPerTick;
  const followupConcurrency = count(
    top.followup_concurrency,
    "followup_concurrency",
    DEFAULTS.followupConcurrency,
  );
  if (!followupConcurrency.ok) return followupConcurrency;
  const receiptsDays = count(
    top.receipts_days,
    "receipts_days",
    DEFAULTS.receiptsDays,
  );
  if (!receiptsDays.ok) return receiptsDays;
  const unclaimedAfterMs = optionalDuration(
    top.unclaimed_after,
    "unclaimed_after",
    DEFAULTS.unclaimedAfterMs,
  );
  if (!unclaimedAfterMs.ok) return unclaimedAfterMs;
  return ok({
    intervalMs: intervalMs.value,
    wallBackoffMs: wallBackoffMs.value,
    runtimeTimeoutMs: runtimeTimeoutMs.value,
    workspaceTimeoutMs: workspaceTimeoutMs.value,
    opensPerTick: opensPerTick.value,
    followupOpensPerTick: followupOpensPerTick.value,
    followupConcurrency: followupConcurrency.value,
    receiptsDays: receiptsDays.value,
    unclaimedAfterMs: unclaimedAfterMs.value,
  });
}

/** The dashboard, the shared records, and whether `jig send` and the change probe run here. */
function surfaces(
  top: Record<string, unknown>,
): Checked<
  Pick<
    MachineConfig,
    | "failures"
    | "dashboardListen"
    | "dashboardRequireToken"
    | "dashboardAllowedHosts"
    | "sharedRecords"
    | "send"
    | "changeProbe"
  >
> {
  const failureSettings = failures(top.failures);
  if (!failureSettings.ok) return failureSettings;
  const dashboardListen = dashboard(top.dashboard);
  if (!dashboardListen.ok) return dashboardListen;
  const requireToken = dashboardRequireToken(top.dashboard);
  if (!requireToken.ok) return requireToken;
  const allowedHosts = dashboardAllowedHosts(top.dashboard);
  if (!allowedHosts.ok) return allowedHosts;
  const sharedRecords = records(top.records);
  if (!sharedRecords.ok) return sharedRecords;
  const send = flag(top.send, "send", true);
  if (!send.ok) return send;
  const changeProbe = flag(top.change_probe, "change_probe", true);
  if (!changeProbe.ok) return changeProbe;
  return ok({
    failures: failureSettings.value,
    dashboardListen: dashboardListen.value,
    dashboardRequireToken: requireToken.value,
    dashboardAllowedHosts: allowedHosts.value,
    sharedRecords: sharedRecords.value,
    send: send.value,
    changeProbe: changeProbe.value,
  });
}

/** Where the shared records live: `forge` when the file names none; a medium this version does not know is refused. */
function records(value: unknown): Checked<SharedMedium> {
  if (value === undefined || value === null) return ok("forge");
  if (!isMapping(value)) return invalid("records must be a mapping");
  const known = only(value, RECORDS_KEYS, "records");
  if (!known.ok) return known;
  const shared = value.shared;
  if (shared === undefined || shared === null) return ok("forge");
  if (!(SHARED_MEDIA as readonly unknown[]).includes(shared))
    return invalid(
      `records.shared must be one of ${SHARED_MEDIA.join(", ")}: ${String(shared)}`,
    );
  return ok(shared as SharedMedium);
}

/** The `failures` settings, each defaulted; a longest wait shorter than the first is refused. */
function failures(value: unknown): Checked<FailureSettings> {
  if (value === undefined || value === null) return ok({ ...FAILURE_DEFAULTS });
  if (!isMapping(value)) return invalid("failures must be a mapping");
  const known = only(value, FAILURES_KEYS, "failures");
  if (!known.ok) return known;
  const backoffMs = optionalDuration(
    value.backoff,
    "failures.backoff",
    FAILURE_DEFAULTS.backoffMs,
  );
  if (!backoffMs.ok) return backoffMs;
  const backoffMaxMs = optionalDuration(
    value.backoff_max,
    "failures.backoff_max",
    FAILURE_DEFAULTS.backoffMaxMs,
  );
  if (!backoffMaxMs.ok) return backoffMaxMs;
  const notifyAfter = count(
    value.notify_after,
    "failures.notify_after",
    FAILURE_DEFAULTS.notifyAfter,
  );
  if (!notifyAfter.ok) return notifyAfter;
  if (backoffMaxMs.value < backoffMs.value)
    return invalid("failures.backoff_max must be at least failures.backoff");
  return ok({
    backoffMs: backoffMs.value,
    backoffMaxMs: backoffMaxMs.value,
    notifyAfter: notifyAfter.value,
  });
}

/** The machine file's `failures` settings, the defaults where it has none. */
export function failureSettings(
  config: Pick<MachineConfig, "failures"> | null | undefined,
): FailureSettings {
  return config?.failures ?? { ...FAILURE_DEFAULTS };
}

/** The dashboard's address; `null` when the file names none. */
function dashboard(value: unknown): Checked<Listen | null> {
  if (value === undefined || value === null) return ok(null);
  if (!isMapping(value)) return invalid("dashboard must be a mapping");
  const known = only(value, DASHBOARD_KEYS, "dashboard");
  if (!known.ok) return known;
  if (value.listen === undefined || value.listen === null) return ok(null);
  const address = text(value.listen, "dashboard.listen");
  if (!address.ok) return address;
  const listen = parseListen(address.value);
  return listen.ok
    ? listen
    : invalid(`dashboard.listen: ${listen.failure.reason}`);
}

/** Whether the dashboard demands its token. Turning it off is accepted only where nothing but a front on this host can reach the port. */
function dashboardRequireToken(value: unknown): Checked<boolean> {
  const listen = dashboard(value);
  if (!listen.ok) return listen;
  const required = flag(
    isMapping(value) ? value.require_token : undefined,
    "dashboard.require_token",
    true,
  );
  if (!required.ok) return required;
  if (!required.value && (listen.value === null || !isLoopback(listen.value)))
    return invalid(
      "dashboard.require_token: false needs a loopback dashboard.listen (127.0.0.1 or ::1), since only a front on this host that authenticates the person may reach a page with no token",
    );
  return required;
}

/** The front host names a tokenless dashboard also answers to. */
function dashboardAllowedHosts(value: unknown): Checked<string[]> {
  const listed = isMapping(value) ? value.allowed_hosts : undefined;
  if (listed === undefined || listed === null) return ok([]);
  if (!Array.isArray(listed))
    return invalid("dashboard.allowed_hosts must be a list");
  const names = each(listed, (name, i) =>
    text(name, `dashboard.allowed_hosts[${i}]`),
  );
  if (!names.ok) return names;
  return ok(names.value.map((name) => name.toLowerCase()));
}

/**
 * The machine file, or `null` when there is none. A file that cannot be read
 * or is not YAML is `unreadable`; one whose values do not validate is
 * `invalid`. Each reason begins with the file's path.
 */
export function readMachineConfig(
  file: string = machineConfigPath(),
): Outcome<MachineConfig | null, MachineConfigCode> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok(null);
    return failed(
      "unreadable",
      `${file} cannot be read: ${(error as Error).message}`,
      error,
    );
  }
  return parseMachineConfigText(raw, file);
}

/** The machine file's text, already read, parsed and validated; `file` names it in reasons. */
export function parseMachineConfigText(
  raw: string,
  file: string,
): Outcome<MachineConfig, MachineConfigCode> {
  let values: unknown;
  try {
    values = load(raw);
  } catch (error) {
    return failed(
      "unreadable",
      `${file} is not YAML: ${(error as Error).message.split("\n")[0]}`,
      error,
    );
  }
  const config = parseMachineConfig(values, file);
  return config.ok ? config : invalid(`${file}: ${config.failure.reason}`);
}

/** The machine file's entry for a repository path, if any. */
export function machineRepository(
  config: MachineConfig | null,
  repoPath: string,
): MachineRepository | null {
  return config?.repositories.find((r) => r.path === resolve(repoPath)) ?? null;
}
