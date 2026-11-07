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
 * The latest attempt's stamp is `upgrade-stamp.ts`'s.
 *
 * A `detail` is held to `DETAIL_LIMIT` characters wherever one is made: the
 * launcher passes the line in an environment variable, which the system
 * bounds, and a failed tool's whole output would otherwise reach every
 * receipt and every withheld line of the interval.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  isMapping,
  readConfigFile,
  userConfigPath,
  userLayerEnabled,
} from "../shared/config-layers.ts";
import { swallow } from "../shared/errors.ts";
import { exclusiveInstallLock } from "../shared/gc-lock.ts";
import { dump } from "../shared/yaml.ts";

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

/** The most characters a `detail` keeps. */
export const DETAIL_LIMIT = 2000;

/** `text` held to `limit` characters: its start and its end, with how much was left out between them. */
export function capped(text: string, limit = DETAIL_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = Math.floor(limit * 0.3);
  return `${text.slice(0, head)} … (${text.length - head - tail} characters left out) … ${text.slice(-tail)}`;
}

/** The upgrade with its `detail` held to `DETAIL_LIMIT`. */
export function bounded<T extends { detail: string }>(upgrade: T): T {
  return { ...upgrade, detail: capped(upgrade.detail) };
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
 * is none. A line that does not read is recorded as a failed upgrade quoting
 * it, so the receipt still says something went wrong.
 */
export function scheduledUpgradeOf(
  env: NodeJS.ProcessEnv = process.env,
): ScheduledUpgrade | undefined {
  const text = env[SCHEDULED_UPGRADE_ENV];
  if (!text) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    swallow(error, "the line is recorded as a failed upgrade instead");
  }
  return isScheduledUpgrade(value)
    ? bounded(value)
    : {
        outcome: "failed",
        detail: capped(`the launcher's upgrade line does not read: ${text}`),
        at: new Date().toISOString(),
      };
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
export function writeWhole(path: string, text: string): void {
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
  return exclusiveInstallLock(async () => {
    const values = readConfigFile(path) ?? {};
    const current = values.upgrade;
    const upgrade = isMapping(current)
      ? { ...current, enabled: false }
      : { enabled: false };
    writeWhole(path, dump({ ...values, upgrade }));
    return path;
  });
}
