/**
 * What the scheduled upgrade records and who reads it. Before each job the
 * launcher runs the installed plugin copy's `jig upgrade --scheduled`
 * (`scheduled-upgrade.ts`), which prints one `ScheduledUpgrade` as a line of
 * JSON; the launcher passes that line to the job in `JIG_SCHEDULED_UPGRADE`,
 * and the job puts it in its receipt (`jig gc`'s and `jig dispatch`'s), from
 * which the morning report lists the upgrades since the last report.
 *
 * The machine's setting is the user file's `upgrade` section
 * (`upgrade: off`, or `every` and `enabled`), read here for the run, for
 * `jig doctor` and for `jig install --no-upgrade`, which writes the opt-out.
 * The upgrade's stamp, under `~/.local/state/jig/upgrade/`, holds the latest
 * attempt: when it started and what it came to. A stamp younger than
 * `upgrade.every` withholds the next attempt, so a failure is not tried
 * again inside the interval, and `jig doctor` fails while the latest attempt
 * failed.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  isMapping,
  readConfigFile,
  userConfigPath,
  userLayerEnabled,
} from "../shared/config-layers.ts";
import { swallow } from "../shared/errors.ts";
import { exclusiveGcLock } from "../shared/gc-lock.ts";
import { dump } from "../shared/yaml.ts";
import type { DoctorCheck } from "./component.ts";

/**
 * The variable the launcher passes a job's scheduled upgrade in: the line
 * `jig upgrade --scheduled` printed, or one the launcher wrote for an
 * upgrade that printed none. `launcher.ts` spells it too: it imports nothing.
 */
export const SCHEDULED_UPGRADE_ENV = "JIG_SCHEDULED_UPGRADE";

/**
 * What a scheduled upgrade came to: `withheld` (the machine opted out,
 * follows a pin, or the interval's attempt was already made), `skipped` (a
 * plugin loaded in place from a local marketplace, left as it is),
 * `unchanged`, `updated`, or `failed`.
 */
const UPGRADE_OUTCOMES = [
  "withheld",
  "skipped",
  "unchanged",
  "updated",
  "failed",
] as const;
export type UpgradeOutcome = (typeof UPGRADE_OUTCOMES)[number];

export interface ScheduledUpgrade {
  outcome: UpgradeOutcome;
  /** Why, in words: the reason it was withheld or skipped, what changed, or the harness's error. */
  detail: string;
  /** When the upgrade ran, or was withheld (an ISO time). */
  at: string;
  /** The version before an update, and the version after it. */
  from?: string;
  to?: string;
}

export function isScheduledUpgrade(value: unknown): value is ScheduledUpgrade {
  return (
    isMapping(value) &&
    typeof value.outcome === "string" &&
    (UPGRADE_OUTCOMES as readonly string[]).includes(value.outcome) &&
    typeof value.detail === "string" &&
    typeof value.at === "string" &&
    (value.from === undefined || typeof value.from === "string") &&
    (value.to === undefined || typeof value.to === "string")
  );
}

/** The upgrade's line in a receipt: `0.114.0 -> 0.115.0`, or the outcome and why. */
export function upgradeLine(upgrade: ScheduledUpgrade): string {
  if (upgrade.outcome === "updated" && upgrade.from && upgrade.to)
    return `${upgrade.from} -> ${upgrade.to}`;
  return `${upgrade.outcome}: ${upgrade.detail}`;
}

/**
 * The scheduled upgrade the launcher passed this job; undefined when there
 * is none or it does not read.
 */
export function scheduledUpgradeOf(
  env: NodeJS.ProcessEnv = process.env,
): ScheduledUpgrade | undefined {
  const text = env[SCHEDULED_UPGRADE_ENV];
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isScheduledUpgrade(value) ? value : undefined;
  } catch (error) {
    swallow(error, "an upgrade line that does not read is left out");
    return undefined;
  }
}

/**
 * The scheduled upgrade the launcher passed this job, taken out of the
 * environment so the sessions the job starts do not inherit it.
 */
export function takeScheduledUpgrade(
  env: NodeJS.ProcessEnv = process.env,
): ScheduledUpgrade | undefined {
  const upgrade = scheduledUpgradeOf(env);
  delete env[SCHEDULED_UPGRADE_ENV];
  return upgrade;
}

/** The machine's setting: whether the timers upgrade the plugin, and how often at most. */
export interface UpgradeSettings {
  enabled: boolean;
  /** `upgrade.every` as written (`1h`), and in milliseconds. */
  every: string;
  everyMs: number;
  /** The user file the setting comes from. */
  path: string;
}

/** A user file's `upgrade` section that cannot be read. */
class UpgradeSettingsError extends Error {
  override name = "UpgradeSettingsError";
}

const DEFAULT_EVERY = "1h";
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `30m`, `1h`, `2d` in milliseconds; null for anything else. */
export function everyMs(text: string): number | null {
  const match = /^([1-9][0-9]{0,5})([mhd])$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/**
 * The user file's `upgrade` section: absent means on, every hour; `off` (or
 * `false`) opts the machine out; a mapping sets `every` and `enabled`. Only
 * the user file sets it: it describes one machine.
 */
export function upgradeSettings(
  env: NodeJS.ProcessEnv = process.env,
): UpgradeSettings {
  const path = userConfigPath(env);
  const fail = (field: string, why: string) =>
    new UpgradeSettingsError(`${path}: ${field} ${why}`);
  const value = userLayerEnabled(env)
    ? readConfigFile(path)?.upgrade
    : undefined;
  const settings = (enabled: boolean, every = DEFAULT_EVERY) => ({
    enabled,
    every,
    everyMs: everyMs(every) as number,
    path,
  });
  if (value === undefined || value === null || value === true || value === "on")
    return settings(true);
  if (value === false || value === "off") return settings(false);
  if (!isMapping(value))
    throw fail("upgrade", "must be off, or a mapping of every and enabled");
  for (const key of Object.keys(value))
    if (key !== "every" && key !== "enabled")
      throw fail("upgrade", `has no field ${key}: it takes every and enabled`);
  const enabled = value.enabled ?? true;
  if (typeof enabled !== "boolean")
    throw fail("upgrade.enabled", "must be true or false");
  const every = value.every ?? DEFAULT_EVERY;
  if (typeof every !== "string" || everyMs(every) === null)
    throw fail(
      "upgrade.every",
      "must be a whole number of minutes, hours or days: 30m, 1h, 2d",
    );
  return settings(enabled, every);
}

/** Writes `text` at `path` whole: staged beside it, then renamed. */
function writeWhole(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * `jig install --no-upgrade`: records the opt-out in the user file as
 * `upgrade.enabled: false`, keeping its other settings, under the lock the
 * installs that write that file take.
 */
export function recordOptOut(env: NodeJS.ProcessEnv = process.env) {
  const path = userConfigPath(env);
  return exclusiveGcLock("install", async () => {
    const values = readConfigFile(path) ?? {};
    const current = values.upgrade;
    const upgrade = isMapping(current)
      ? { ...current, enabled: false }
      : { enabled: false };
    writeWhole(path, dump({ ...values, upgrade }));
    return path;
  });
}

/** Where the scheduled upgrade keeps its stamp and the lock that claims an interval. */
export function upgradeStateRoot(home = homedir()): string {
  return join(home, ".local", "state", "jig", "upgrade");
}

/** The latest scheduled upgrade: `running` from its claim until it records what it came to. */
export interface UpgradeStamp extends Omit<ScheduledUpgrade, "outcome"> {
  outcome: UpgradeOutcome | "running";
  /** The process that made the attempt. */
  pid: number;
}

export function stampPath(root = upgradeStateRoot()): string {
  return join(root, "last.json");
}

/** The latest attempt's stamp; null when none was made or it does not read. */
export function readStamp(path = stampPath()): UpgradeStamp | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    swallow(error, "a stamp that does not read claims no interval");
    return null;
  }
  if (!isMapping(value) || typeof value.pid !== "number") return null;
  const outcome = value.outcome;
  return (outcome === "running" || isScheduledUpgrade(value)) &&
    typeof value.detail === "string" &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at))
    ? (value as unknown as UpgradeStamp)
    : null;
}

export function writeStamp(stamp: UpgradeStamp, path = stampPath()): void {
  writeWhole(path, `${JSON.stringify(stamp)}\n`);
}

/** How long an attempt may stay `running` before `jig doctor` says it did not finish. */
const RUNNING_LIMIT_MS = 60 * 60_000;

/**
 * `jig doctor`'s check of the scheduled upgrade: it fails while the latest
 * attempt failed, or one started and never finished, naming that attempt and
 * the harness's error; it passes once a later attempt succeeds. It is skipped
 * on a machine that opted out or where no job has upgraded yet.
 */
export function upgradeCheck(now = new Date()): DoctorCheck {
  const id = "upgrade";
  let settings: UpgradeSettings;
  try {
    settings = upgradeSettings();
  } catch (error) {
    return {
      id,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "edit the user file: CONFIGURATION.md's upgrade section lists its settings",
    };
  }
  if (!settings.enabled)
    return {
      id,
      status: "skip",
      detail: `the timers do not upgrade the plugin: upgrade is off in ${settings.path}`,
    };
  const stamp = readStamp();
  if (stamp === null)
    return { id, status: "skip", detail: "no job has upgraded the plugin yet" };
  const fix = `jig upgrade, which prints each command and its error; the timers try again ${settings.every} after the failed attempt`;
  if (stamp.outcome === "failed")
    return {
      id,
      status: "fail",
      detail: `the scheduled upgrade at ${stamp.at} failed: ${stamp.detail}`,
      fix,
    };
  if (stamp.outcome === "running")
    return now.getTime() - Date.parse(stamp.at) > RUNNING_LIMIT_MS
      ? {
          id,
          status: "fail",
          detail: `the scheduled upgrade started at ${stamp.at} did not finish`,
          fix,
        }
      : {
          id,
          status: "pass",
          detail: `a scheduled upgrade started at ${stamp.at} is running`,
        };
  return {
    id,
    status: "pass",
    detail: `the scheduled upgrade at ${stamp.at}: ${upgradeLine(stamp as ScheduledUpgrade)}`,
  };
}
