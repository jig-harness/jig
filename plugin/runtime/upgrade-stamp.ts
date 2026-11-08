/**
 * The scheduled upgrade's stamp, `~/.local/state/jig/upgrade/last.json`:
 * the latest attempt, when it started, what it came to and the process that
 * made it. `jig upgrade --scheduled` (`scheduled-upgrade.ts`) writes it
 * `running` when it claims an interval and again with the outcome; a
 * successful `jig upgrade` a person runs writes it too. While the stamp is
 * younger than `upgrade.every`, or `running` with its holder still alive,
 * the next attempt is withheld: a `running` stamp whose holder died counts
 * as a failed attempt, due again only once the interval has passed. `jig doctor` fails while the latest attempt
 * failed, or its holder died before it finished.
 *
 * A stamp that cannot be read is no claim: the next attempt is due, and
 * overwrites it, while `jig doctor` names it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMapping } from "../shared/config-layers.ts";
import { errnoCode } from "../shared/errors.ts";
import { withFileLock } from "../shared/file-lock.ts";
import {
  decodeIdentity,
  isAliveSync,
  legacyIdentity,
  ownIdentity,
  type ProcessIdentity,
  relate,
} from "../shared/liveness.ts";
import type { DoctorCheck } from "./component.ts";
import {
  bounded,
  isScheduledUpgrade,
  type ScheduledUpgrade,
  type UpgradeOutcome,
  type UpgradeSettings,
  upgradeLine,
  upgradeSettings,
  writeWhole,
} from "./upgrade-record.ts";

/** The stamp's schema version. */
const STAMP_VERSION = 1;

export interface UpgradeStamp extends Omit<ScheduledUpgrade, "outcome"> {
  version?: number;
  /** `running` from the claim until the attempt records what it came to. */
  outcome: UpgradeOutcome | "running";
  /** The process that made the attempt, and its identity (host, boot, start time). */
  pid: number;
  holder?: ProcessIdentity;
}

/** The stamp as read: one, none written yet, or a file that does not read and why. */
export type StampRead =
  | { stamp: UpgradeStamp }
  | { none: true }
  | { unreadable: string };

/** Where the scheduled upgrade keeps its stamp and the lock that claims an interval. */
export function upgradeStateRoot(home = homedir()): string {
  return join(home, ".local", "state", "jig", "upgrade");
}

export function stampPath(root = upgradeStateRoot()): string {
  return join(root, "last.json");
}

function isStamp(value: unknown): value is UpgradeStamp {
  return (
    isMapping(value) &&
    typeof value.pid === "number" &&
    (value.outcome === "running"
      ? typeof value.detail === "string" && typeof value.at === "string"
      : isScheduledUpgrade(value)) &&
    Number.isFinite(Date.parse(value.at as string))
  );
}

export function readStamp(path = stampPath()): StampRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { none: true };
    return { unreadable: `${path} cannot be read: ${String(error)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { unreadable: `${path} is not JSON: ${String(error)}` };
  }
  return isStamp(value)
    ? { stamp: value }
    : { unreadable: `${path} does not hold an upgrade stamp` };
}

/** Writes the stamp whole, with this process as its holder and its detail held to the limit. */
export function writeStamp(
  stamp: Omit<UpgradeStamp, "pid" | "holder" | "version">,
  path = stampPath(),
): void {
  const holder = ownIdentity();
  writeWhole(
    path,
    `${JSON.stringify({ ...bounded(stamp), version: STAMP_VERSION, pid: holder.pid, holder })}\n`,
  );
}

/** Whether `stamp` is a `running` claim made by this process. */
export function ownsClaim(read: StampRead): boolean {
  if (!("stamp" in read) || read.stamp.outcome !== "running") return false;
  const own = ownIdentity();
  const holder =
    read.stamp.holder === undefined ? null : decodeIdentity(read.stamp.holder);
  // The process, not the host's current name: a rename between claim and finish is the same holder.
  return (
    read.stamp.pid === own.pid &&
    holder !== null &&
    relate(holder, own) === "same"
  );
}

/** Whether `read` is another process's `running` claim whose holder is still alive (or cannot be judged). */
export function liveForeignClaim(read: StampRead): boolean {
  if (!("stamp" in read) || read.stamp.outcome !== "running") return false;
  return !ownsClaim(read) && !holderOf(read.stamp).gone;
}

/**
 * Writes `stamp` under the lock that claims an interval, and only when `may`
 * allows it given the stamp standing then, so a write is fenced to the claim
 * it answers. False when the lock was not taken or `may` refused.
 */
export async function writeStampWhen(
  stamp: Omit<UpgradeStamp, "pid" | "holder" | "version">,
  may: (standing: StampRead) => boolean,
): Promise<boolean> {
  const root = upgradeStateRoot();
  const taken = await withFileLock(
    stampPath(root),
    async () => {
      if (!may(readStamp(stampPath(root)))) return false;
      writeStamp(stamp, stampPath(root));
      return true;
    },
    { root, name: "claim" },
  );
  return taken?.value ?? false;
}

/**
 * The stamp's holder as judged now: `gone` with why, or not gone, with why
 * it could not be judged when it could not be. A holder that cannot be
 * judged is taken to still run.
 */
export function holderOf(
  stamp: UpgradeStamp,
): { gone: true; reason: string } | { gone: false; unjudged?: string } {
  const identity =
    (stamp.holder === undefined ? null : decodeIdentity(stamp.holder)) ??
    legacyIdentity(stamp.pid);
  const verdict = isAliveSync(identity);
  if (!verdict.ok) return { gone: false, unjudged: verdict.failure.reason };
  return verdict.value.state === "dead"
    ? { gone: true, reason: verdict.value.reason }
    : { gone: false };
}

/** How a running attempt whose holder lives, or cannot be judged, is described. */
export function stillRunning(
  stamp: UpgradeStamp,
  holder: { unjudged?: string },
): string {
  return holder.unjudged === undefined
    ? `the upgrade a job started at ${stamp.at} is still running`
    : `the upgrade a job started at ${stamp.at} is taken to be still running: its process cannot be judged (${holder.unjudged})`;
}

/**
 * `jig doctor`'s check of the scheduled upgrade: it fails while the latest
 * attempt failed, or its holder died before it finished, naming that attempt
 * and the harness's error, and when the stamp does not read; it passes once
 * a later attempt succeeds. It is skipped on a machine that opted out or
 * where no upgrade has been stamped yet.
 */
export function upgradeCheck(): DoctorCheck {
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
  const read = readStamp();
  if ("none" in read)
    return { id, status: "skip", detail: "no job has upgraded the plugin yet" };
  if ("unreadable" in read)
    return {
      id,
      status: "fail",
      detail: read.unreadable,
      fix: "remove the file: the next timer's job upgrades and writes it again",
    };
  const { stamp } = read;
  const fix = `jig upgrade, which prints each command and its error; the timers try again ${settings.every} after the failed attempt`;
  if (stamp.outcome === "failed")
    return {
      id,
      status: "fail",
      detail: `the scheduled upgrade at ${stamp.at} failed: ${stamp.detail}`,
      fix,
    };
  if (stamp.outcome === "running") {
    const holder = holderOf(stamp);
    return holder.gone
      ? {
          id,
          status: "fail",
          detail: `the scheduled upgrade started at ${stamp.at} did not finish: ${holder.reason}`,
          fix,
        }
      : { id, status: "pass", detail: stillRunning(stamp, holder) };
  }
  return {
    id,
    status: "pass",
    detail: `the latest upgrade, at ${stamp.at}: ${upgradeLine(stamp as ScheduledUpgrade)}`,
  };
}
