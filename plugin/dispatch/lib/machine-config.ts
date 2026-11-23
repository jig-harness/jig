/**
 * The machine file, `$JIG_HOME/dispatch.yaml` (default
 * `~/.jig/dispatch.yaml`): what this machine dispatches and on whose
 * accounts. A repository's own `dispatch` section says what it wants; this
 * file says which repositories this machine starts stages for, which
 * stages, and which accounts it may bill: subscription accounts, and
 * provider accounts that bill a model provider with the host's own key
 * (`provider-account.ts`, `machine-accounts.ts`). Nothing a repository
 * holds can widen it, and a repository's own `dispatch.allowed_providers`
 * narrows which of these accounts its passes may use (`provider-allow.ts`).
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
 *     # stages: [pickup, followup] # the launching stages it serves; every one when left out
 *   - name: router           # a provider account: provider-account.ts has every key
 *     kind: provider
 *     harness: claude-code
 *     provider: openrouter
 *     credential: op://Jig/router/credential   # a reference, never the key
 *     spend_cap: {daily: "20.00"}
 * credential_command: [op, read, --no-newline]  # resolves a provider account's reference
 * credential_timeout: 10s
 * credential_env: [OP_SERVICE_ACCOUNT_TOKEN]    # the host's variables that command needs; no pass carries them
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
 *   rerun_died: 1      # 0 runs no follow-up again after a death or an unwritten result
 *   group: cause            # or scope: one notice per failing scope
 * dashboard:
 *   listen: 100.64.0.7:8765
 *   require_token: true     # false only with a loopback listen: a front authenticates
 *   allowed_hosts: []       # host names that front forwards under (tokenless only)
 *   # front: https://host.example.ts.net:8443/ # that front's token-free address (tokenless only)
 * records:
 *   shared: forge
 * send: true
 * change_probe: true
 * outbound_share: 0.5   # was tracker_share, which still reads
 * preflight: [tracker]   # the checks run on each account before a tracker stage: preflight-config.ts
 * notify:
 *   channels: []          # notification channels beside the Orca card: notify-config.ts
 * load:
 *   enforce: false          # the gauges' lines and reservations: load-config.ts
 * priorities:
 *   enforce: false          # pickups start in the ranking's order: priorities-config.ts
 * ```
 *
 * An unknown key anywhere is refused, so a misspelt dial never reads as its
 * default.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMapping, jigHome } from "../../shared/config-layers.ts";
import { OPEN_LIMIT_MS } from "../../shared/orca-workspace/limits.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { DEFAULT_DISPATCHER_SHARE } from "../../shared/outbound/budget.ts";
import { load } from "../../shared/yaml.ts";
import { FRONT_RULES, shownFront } from "./dashboard-front.ts";
import {
  DEFAULT_STARTUP_THRESHOLD,
  FAILURE_DEFAULTS,
  type FailureGrouping,
  type FailureSettings,
} from "./failures.ts";
import { isLoopback, type Listen, parseListen } from "./listen.ts";
import { type LoadSettings, loadSettings } from "./load-config.ts";
import {
  type NotifyChannelConfig,
  notifyChannels,
  notifyStageFault,
} from "./notify-config.ts";
import { type PreflightProbe, preflightSetting } from "./preflight-config.ts";
import { type ServedPerson, servedPeople } from "./serve-config.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import { duration } from "./duration.ts";
import {
  type Checked,
  count,
  distinct,
  each,
  flag,
  invalid,
  list,
  only,
  path,
  text,
} from "./machine-values.ts";
import { machineAccounts } from "./machine-accounts.ts";
import {
  type CredentialSettings,
  credentialSettings,
  type ProviderAccount,
} from "./provider-account.ts";
import { withholdFromPasses } from "./provider-environment.ts";
import {
  type MachineStage,
  machineStages,
  type ServedStage,
} from "./account-stages.ts";
import {
  type PrioritiesSettings,
  prioritiesSettings,
} from "./priorities-config.ts";

import {
  processSettings,
  type ProcessSettings,
} from "./runtime/process-environment.ts";

export { duration };

export type { MachineStage };

export interface MachineAccount {
  /** The account's name here, which launch records and walls are keyed by. */
  name: string;
  /**
   * The agent tool the account bills (`claude`, `codex`): it chooses the
   * agent every session on the account runs in. Any name is accepted; one
   * the drive documents no pass command for is reported and never admitted.
   * A provider account's is its harness's program (`claude` for
   * `claude-code`).
   */
  vendor: string;
  /** The account's Orca profile configuration directory (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`). */
  configDir: string;
  /** What the drive's identity resolver reads from that directory: an email address or an account id; a provider account's derived `provider:<provider>:<fingerprint>`. */
  identity: string;
  /** Sessions the dispatcher may hold on it at once. */
  maxPerAccount: number;
  /** The launching stages it serves (`account-stages.ts`); absent, every one. */
  stages?: ServedStage[];
  /** A provider account's fields (`kind: provider`); absent for a subscription account, whose vendor is its provider. */
  provider?: ProviderAccount;
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
  runtime?: "orca" | "process";
  process?: ProcessSettings;
  steward?: { enabled: boolean };
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
  /** The token-free HTTPS address a private-network front publishes for the dashboard (`dashboard.front`), in its canonical form; `null` unless the file names one, which only `require_token: false` accepts. */
  dashboardFront: string | null;
  /** Where the records another host reads are shared (`records.shared`). */
  sharedRecords: SharedMedium;
  /** Whether `jig send` may write a request from this machine (`send`); `true` unless the file says `false`. */
  send: boolean;
  /** Whether the change probe wakes the ticks of repositories that changed on the forge (`change_probe`); `true` unless the file says `false`. */
  changeProbe: boolean;
  /** The host's gauges' lines, the kinds' default reservations and whether the load factor holds launches (`load`). */
  load: LoadSettings;
  /** Whether pickups start in the declared-priorities ranking's order (`priorities`); off when absent. */
  priorities?: PrioritiesSettings;
  /** The share of each rate-limit window, a tracker's or the forge's, the tick's own calls may use (`outbound_share`, or its older name `tracker_share`); `DEFAULT_DISPATCHER_SHARE` when absent. */
  outboundShare?: number;
  /** The checks the tick runs on each account before a stage that needs them (`preflight`); `[tracker]` when absent. */
  preflight?: PreflightProbe[];
  /** The notification channels the tick sends through beside the Orca card (`notify.channels`); none when absent. */
  notifyChannels?: NotifyChannelConfig[];
  /** How a provider account's credential reference is resolved (`credential_command`, `credential_timeout`, `provider_hosts`); absent where a test builds a configuration by hand. */
  credentials?: CredentialSettings;
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
  "runtime",
  "process",
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
  "priorities",
  "outbound_share",
  "tracker_share",
  "preflight",
  "notify",
  "credential_command",
  "credential_timeout",
  "credential_env",
  "provider_hosts",
];
const DASHBOARD_KEYS = ["listen", "require_token", "allowed_hosts", "front"];
const FAILURES_KEYS = [
  "backoff",
  "backoff_max",
  "notify_after",
  "rerun_died",
  "startup_threshold",
  "group",
];
const RECORDS_KEYS = ["shared"];
const REPOSITORY_KEYS = ["path", "stages", "followup_since", "owner"];

/**
 * Why the machine file, or one of its values, is refused: `unreadable` for a
 * file that cannot be read or is not YAML, `invalid` for a value that does
 * not validate. The reason names the file and the setting.
 */
export type MachineConfigCode = "unreadable" | "invalid";

export function machineConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jigHome(env), "dispatch.yaml");
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

/** A share of a budget: more than 0, at most 1. */
function share(value: unknown, where: string): Checked<number> {
  if (value === undefined || value === null)
    return ok(DEFAULT_DISPATCHER_SHARE);
  if (typeof value !== "number" || !(value > 0 && value <= 1))
    return invalid(`${where} must be a number above 0 and at most 1`);
  return ok(value);
}

function since(value: unknown, where: string): Checked<string | null> {
  if (value === undefined || value === null) return ok(null);
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" || !Number.isFinite(parseMs(raw)))
    return invalid(`${where} must be a date`);
  return ok(isoFromMs(parseMs(raw)));
}

function repository(value: unknown, i: number): Checked<MachineRepository> {
  const where = `repositories[${i}]`;
  if (!isMapping(value)) return invalid(`${where} must be a mapping`);
  const known = only(value, REPOSITORY_KEYS, where);
  if (!known.ok) return known;
  const repoPath = path(value.path, `${where}.path`);
  if (!repoPath.ok) return repoPath;
  const enabled = machineStages(value.stages, `${where}.stages`);
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

/** `linear:<team>`, or `jira:<site>:<project>` where the site is the https hostname the Jira settings accept (no port), its scheme colon kept. */
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
  return /^https:\/\/[a-z0-9.-]+$/.test(site) && project !== "";
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

/** Read repository stages together with the machine's session runtime. */
function machineRepositories(
  top: Record<string, unknown>,
  where: string,
): Checked<{
  runtime: "orca" | "process";
  process: ProcessSettings;
  repositories: MachineRepository[];
  notifyChannels?: NotifyChannelConfig[];
}> {
  const repos = repositories(top.repositories);
  if (!repos.ok) return repos;
  const runtime = top.runtime ?? "orca";
  if (runtime !== "orca" && runtime !== "process")
    return invalid(`${where}: runtime must be orca or process`);
  if (runtime === "process" && !["linux", "darwin"].includes(process.platform))
    return invalid(
      `${where}: runtime: process is supported on Linux and macOS only`,
    );
  const settings = processSettings(top.process);
  if (!settings.ok) return settings;
  const channels = notifyChannels(top.notify);
  if (!channels.ok) return channels;
  const fault = notifyStageFault(runtime, channels.value, repos.value);
  if (fault !== null) return invalid(`${where}: ${fault}`);
  return ok({
    runtime,
    process: settings.value,
    repositories: repos.value,
    ...(channels.value.length === 0 ? {} : { notifyChannels: channels.value }),
  });
}

function parseValues(values: unknown, where: string): Checked<MachineConfig> {
  const top = values ?? {};
  if (!isMapping(top)) return invalid(`${where} must be a mapping`);
  const known = only(top, TOP_KEYS, where);
  if (!known.ok) return known;
  const serve = servedPeople(top.serve);
  if (!serve.ok) return serve;
  const repos = machineRepositories(top, where);
  if (!repos.ok) return repos;
  const defaults = serveDefaults(top.serve_defaults, repos.value.repositories);
  if (!defaults.ok) return defaults;
  const credentials = credentialSettings(top);
  if (!credentials.ok) return credentials;
  const accountList = machineAccounts(
    top.accounts,
    credentials.value,
    DEFAULTS.maxPerAccount,
  );
  if (!accountList.ok) return accountList;
  const timing = limits(top);
  if (!timing.ok) return timing;
  const shared = surfaces(top);
  if (!shared.ok) return shared;
  const host = loadSettings(top.load);
  if (!host.ok) return host;
  const steward = stewardSettings(top.steward);
  if (!steward.ok) return steward;
  const priorities = prioritiesSettings(top.priorities);
  if (!priorities.ok) return priorities;
  const tracker = trackerSettings(top);
  if (!tracker.ok) return tracker;
  return ok({
    ...tracker.value,
    ...repos.value,
    path: where,
    serve: serve.value,
    serveDefaults: defaults.value,
    accounts: accountList.value,
    credentials: credentials.value,
    ...withCredentialEnv(repos.value.process, credentials.value.credentialEnv),
    ...timing.value,
    ...shared.value,
    load: host.value,
    steward: steward.value,
    priorities: priorities.value,
  });
}

/** The process runtime's settings, given the credential command's variables to hand to a provider account's wrapper. */
function withCredentialEnv(
  settings: ProcessSettings,
  names: string[],
): { process: ProcessSettings } {
  return {
    process:
      names.length === 0 ? settings : { ...settings, credentialEnv: names },
  };
}

/** The tick's share of each credential's budget, and the checks run on each account before a tracker stage. */
function trackerSettings(
  top: Record<string, unknown>,
): Checked<Pick<MachineConfig, "outboundShare" | "preflight">> {
  const named = top.outbound_share !== undefined && top.outbound_share !== null;
  const older = top.tracker_share !== undefined && top.tracker_share !== null;
  if (named && older)
    return invalid(
      "outbound_share and tracker_share name one setting: keep outbound_share and remove tracker_share",
    );
  const outboundShare = older
    ? share(top.tracker_share, "tracker_share")
    : share(top.outbound_share, "outbound_share");
  if (!outboundShare.ok) return outboundShare;
  const preflight = preflightSetting(top.preflight);
  if (!preflight.ok) return preflight;
  return ok({ outboundShare: outboundShare.value, preflight: preflight.value });
}

/**
 * The steward's settings. `every` is still accepted, as a duration, so a
 * file that sets it keeps reading; the judgment backlog starts a pass, and
 * no cadence is waited on.
 */
function stewardSettings(value: unknown): Checked<{ enabled: boolean }> {
  if (value === undefined || value === null) return ok({ enabled: false });
  if (!isMapping(value)) return invalid("steward must be a mapping");
  const known = only(value, ["enabled", "every"], "steward");
  if (!known.ok) return known;
  const enabled = flag(value.enabled, "steward.enabled", false);
  if (!enabled.ok) return enabled;
  const every = optionalDuration(value.every, "steward.every", 0);
  if (!every.ok) return every;
  return ok({ enabled: enabled.value });
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
    | "dashboardFront"
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
  const front = dashboardFront(top.dashboard, requireToken.value);
  if (!front.ok) return front;
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
    dashboardFront: front.value,
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
  const startupThreshold = count(
    value.startup_threshold,
    "failures.startup_threshold",
    DEFAULT_STARTUP_THRESHOLD,
  );
  if (!startupThreshold.ok) return startupThreshold;
  const rerunDied = value.rerun_died ?? FAILURE_DEFAULTS.rerunDied;
  // A run again never earns another, so the bound is one or none.
  if (rerunDied !== 0 && rerunDied !== 1)
    return invalid("failures.rerun_died must be 0 or 1");
  if (backoffMaxMs.value < backoffMs.value)
    return invalid("failures.backoff_max must be at least failures.backoff");
  const group = failureGrouping(value.group);
  if (!group.ok) return group;
  return ok({
    backoffMs: backoffMs.value,
    backoffMaxMs: backoffMaxMs.value,
    notifyAfter: notifyAfter.value,
    rerunDied,
    startupThreshold: startupThreshold.value,
    group: group.value,
  });
}

/** `failures.group`: `cause` when absent. */
function failureGrouping(value: unknown): Checked<FailureGrouping> {
  if (value === undefined || value === null) return ok("cause");
  return value === "cause" || value === "scope"
    ? ok(value)
    : invalid(`failures.group must be cause or scope: ${String(value)}`);
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
 * The address a front publishes for a phone to open: an absolute `https:`
 * URL with no user name, password, query or fragment, and no escaped query
 * or parameter in its path, whose host is a name or a private address other
 * than loopback and link-local. It is printed in URL-canonical form, so it must not
 * carry a token anywhere. A name is taken as written: Jig never resolves it,
 * nor infers how far it reaches. Only a tokenless dashboard has a front to
 * name.
 */
function dashboardFront(
  value: unknown,
  requireToken: boolean,
): Checked<string | null> {
  const given = isMapping(value) ? value.front : undefined;
  if (given === undefined || given === null) return ok(null);
  const address = text(given, "dashboard.front");
  if (!address.ok) return address;
  if (!URL.canParse(address.value))
    return invalid(
      "dashboard.front is not an absolute URL (its value is withheld, since it may hold a credential)",
    );
  const url = new URL(address.value);
  const refuse = (why: string) =>
    invalid(`dashboard.front: ${shownFront(url)} ${why}`);
  const broken = FRONT_RULES.find(([holds]) => !holds(url, address.value));
  if (broken !== undefined) return refuse(broken[1]);
  if (requireToken)
    return refuse(
      "needs dashboard.require_token: false, since a front's address carries no token and only a dashboard that asks for none answers it",
    );
  return ok(url.href);
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
  if (!config.ok) return invalid(`${file}: ${config.failure.reason}`);
  // No pass this process starts carries the credential command's variables.
  withholdFromPasses(config.value.credentials?.credentialEnv ?? []);
  return config;
}

/** The machine file's entry for a repository path, if any. */
export function machineRepository(
  config: MachineConfig | null,
  repoPath: string,
): MachineRepository | null {
  return config?.repositories.find((r) => r.path === resolve(repoPath)) ?? null;
}
