/**
 * The scheduled upgrade's stamp, `~/.local/state/jig/upgrade/last.json`:
 * the latest attempt, when it started, what it came to and the process that
 * made it. `jig upgrade --scheduled` (`scheduled-upgrade.ts`) writes it
 * `running` when it claims an interval and again with the outcome; a
 * successful `jig upgrade` a person runs writes it too. While the stamp is
 * younger than `upgrade.every`, or `running` with its holder still alive,
 * the next attempt is withheld. `jig doctor` fails while the latest attempt
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
import {
  decodeIdentity,
  isAliveSync,
  legacyIdentity,
  ownIdentity,
  type ProcessIdentity,
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

/** Why the stamp's holder counts as gone; null while it may still run, or cannot be judged. */
export function holderGone(stamp: UpgradeStamp): string | null {
  const identity =
    (stamp.holder === undefined ? null : decodeIdentity(stamp.holder)) ??
    legacyIdentity(stamp.pid);
  const verdict = isAliveSync(identity);
  return verdict.ok && verdict.value.state === "dead"
    ? verdict.value.reason
    : null;
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
    const gone = holderGone(stamp);
    return gone === null
      ? {
          id,
          status: "pass",
          detail: `a scheduled upgrade started at ${stamp.at} is running`,
        }
      : {
          id,
          status: "fail",
          detail: `the scheduled upgrade started at ${stamp.at} did not finish: ${gone}`,
          fix,
        };
  }
  return {
    id,
    status: "pass",
    detail: `the latest upgrade, at ${stamp.at}: ${upgradeLine(stamp as ScheduledUpgrade)}`,
  };
}
