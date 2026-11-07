/**
 * The plugin upgrades the timers ran on this machine since the report's
 * time, for the morning report: before each job its launcher runs the
 * scheduled upgrade, and the job's receipt keeps what it came to
 * (`runtime/upgrade-record.ts`), resource collection's
 * (`plugin/gc/receipts.ts`) and the dispatcher's (`plugin/dispatch/receipts.ts`)
 * alike. The report lists each upgrade that moved the plugin and each that
 * failed, once, at the time it ran; one withheld, skipped or unchanged says
 * nothing a person must read. A failure that repeats with the same words (a
 * setting that does not read fails every tick) is one entry: when it first
 * and last came, and how many times.
 */
import { basename, dirname } from "node:path";
import {
  readReceipt as readTickReceipt,
  receiptPaths as tickReceiptPaths,
} from "../../../../dispatch/receipts.ts";
import {
  readReceipt as readGcReceipt,
  receiptPaths as gcReceiptPaths,
} from "../../../../gc/receipts.ts";
import {
  isScheduledUpgrade,
  type ScheduledUpgrade,
  upgradeLine,
} from "../../../../runtime/upgrade-record.ts";

export interface UpgradeEntry {
  /** When the upgrade ran; for a failure that repeated, when it first came. */
  at: string;
  /** When a repeated failure last came; `at` for one that came once. */
  last: string;
  /** How many times it came. */
  count: number;
  /** The job whose receipt holds it: `gc` or `dispatch`. */
  job: string;
  outcome: "updated" | "failed";
  /** Its line in the receipt: `0.114.0 -> 0.115.0`, or `failed: ` and the harness's error. */
  line: string;
}

export interface UpgradesSince {
  entries: UpgradeEntry[];
  /** What could not be read, each a sentence. */
  unread: string[];
}

/** Where each job's receipts are: tests name their own. */
export interface ReceiptRoots {
  gc?: string;
  dispatch?: string;
}

/**
 * Each job's receipts from the day before `since` on, read: the upgrade each
 * holds. A receipt sits under the day its run started, and its upgrade ran
 * just before, so an older day holds none since `since`. A receipt that does
 * not read goes into `unread`.
 */
function upgradesOf(
  since: number,
  roots: ReceiptRoots,
  unread: string[],
): Array<[string, unknown]> {
  const first = Number.isFinite(since)
    ? new Date(since - 86_400_000).toISOString().slice(0, 10)
    : "";
  const found: Array<[string, unknown]> = [];
  /** Each job: its receipts' paths, and a receipt read, or why it does not read. */
  const jobs: Array<
    [string, () => string[], (path: string) => { upgrade?: unknown } | string]
  > = [
    [
      "gc",
      () => gcReceiptPaths(roots.gc),
      (path) => {
        try {
          return readGcReceipt(path);
        } catch (error) {
          return String(error);
        }
      },
    ],
    [
      "dispatch",
      () => tickReceiptPaths(roots.dispatch),
      (path) => readTickReceipt(path) ?? "it is not a tick's receipt",
    ],
  ];
  for (const [job, paths, read] of jobs) {
    let listed: string[];
    try {
      listed = paths();
    } catch (error) {
      unread.push(`the ${job} receipts could not be listed (${String(error)})`);
      continue;
    }
    for (const path of listed.filter(
      (path) => basename(dirname(path)) >= first,
    )) {
      const receipt = read(path);
      if (typeof receipt === "string")
        unread.push(`the ${job} receipt ${path} does not read (${receipt})`);
      else if (receipt.upgrade !== undefined)
        found.push([job, receipt.upgrade]);
    }
  }
  return found;
}

/** The entries so far, and the attempts counted, so one attempt seen in two receipts counts once. */
interface Tally {
  entries: Map<string, UpgradeEntry>;
  attempts: Set<string>;
}

/** Counts one upgrade into the tally: an update is one attempt, in one receipt; a failure is one entry per wording. */
function count(
  tally: Tally,
  job: string,
  upgrade: ScheduledUpgrade & { outcome: "updated" | "failed" },
): void {
  const line = upgradeLine(upgrade);
  const key =
    upgrade.outcome === "updated"
      ? `${upgrade.at}\0${line}`
      : `failed\0${line}`;
  const attempt = `${key}\0${upgrade.at}`;
  const seen = tally.entries.get(key);
  if (seen === undefined)
    tally.entries.set(key, {
      at: upgrade.at,
      last: upgrade.at,
      count: 1,
      job,
      outcome: upgrade.outcome,
      line,
    });
  else if (!tally.attempts.has(attempt)) {
    seen.count += 1;
    if (upgrade.at < seen.at) seen.at = upgrade.at;
    if (upgrade.at > seen.last) seen.last = upgrade.at;
  }
  tally.attempts.add(attempt);
}

/** Whether a report lists the upgrade: one that moved the plugin or failed, since `since`. */
function listed(
  upgrade: ScheduledUpgrade,
  since: number,
): upgrade is ScheduledUpgrade & { outcome: "updated" | "failed" } {
  return (
    (upgrade.outcome === "updated" || upgrade.outcome === "failed") &&
    Date.parse(upgrade.at) >= since
  );
}

/** The upgrades that moved the plugin or failed since `since` (milliseconds), oldest first. */
export function upgradesSince(
  since: number,
  roots: ReceiptRoots = {},
): UpgradesSince {
  const unread: string[] = [];
  const tally: Tally = { entries: new Map(), attempts: new Set() };
  const entries = tally.entries;
  for (const [job, upgrade] of upgradesOf(since, roots, unread)) {
    if (!isScheduledUpgrade(upgrade))
      unread.push(`a ${job} receipt holds an upgrade that does not read`);
    else if (listed(upgrade, since)) count(tally, job, upgrade);
  }
  return {
    entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at)),
    unread,
  };
}
