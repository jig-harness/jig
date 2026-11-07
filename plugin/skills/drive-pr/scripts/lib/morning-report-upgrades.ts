/**
 * The plugin upgrades the timers ran on this machine since the report's
 * time, for the morning report: before each job its launcher runs the
 * scheduled upgrade, and the job's receipt keeps what it came to
 * (`runtime/upgrade-record.ts`), resource collection's
 * (`plugin/gc/receipts.ts`) and the dispatcher's (`plugin/dispatch/receipts.ts`)
 * alike. The report lists each upgrade that moved the plugin and each that
 * failed, once, at the time it ran; one withheld, skipped or unchanged says
 * nothing a person must read.
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
  /** When the upgrade ran. */
  at: string;
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

/** The upgrades that moved the plugin or failed since `since` (milliseconds), oldest first. */
export function upgradesSince(
  since: number,
  roots: ReceiptRoots = {},
): UpgradesSince {
  const unread: string[] = [];
  const entries = new Map<string, UpgradeEntry>();
  for (const [job, upgrade] of upgradesOf(since, roots, unread)) {
    if (!isScheduledUpgrade(upgrade)) {
      unread.push(`a ${job} receipt holds an upgrade that does not read`);
      continue;
    }
    const outcome = (upgrade as ScheduledUpgrade).outcome;
    if (outcome !== "updated" && outcome !== "failed") continue;
    if (!(Date.parse(upgrade.at) >= since)) continue;
    // One attempt is in one receipt; a copy of it is the same upgrade.
    entries.set(`${upgrade.at}\0${outcome}`, {
      at: upgrade.at,
      job,
      outcome,
      line: upgradeLine(upgrade),
    });
  }
  return {
    entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at)),
    unread,
  };
}
