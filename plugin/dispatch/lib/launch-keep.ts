/** Which launch records pruning keeps as the only evidence of what was already done. */
import { cancelledBeforeExecution } from "./cancellation.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { ReadRecord } from "./launches.ts";
import {
  FAILED_TAKEOVERS,
  failedTakeoverExit,
  NOT_SETTLED_ENDS_KEPT,
} from "./repeated-end-caps.ts";

const isDrive = (action: string): boolean =>
  action === "rearm" || action === "takeover";

function latestDrives(records: ReadRecord[]): ReadRecord[] {
  return latestBy(records, (r) =>
    isDrive(r.record.action) && !cancelledBeforeExecution(r)
      ? `${r.record.repo}#${String(r.record.pr)}`
      : null,
  );
}

/** The ids of the latest record under each key `keyOf` gives; a record it gives `null` is not kept. */
function latestIdsBy(
  records: ReadRecord[],
  keyOf: (r: ReadRecord) => string | null,
): Set<string> {
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    const key = keyOf(r);
    if (key === null) continue;
    const seen = latest.get(key);
    if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
      latest.set(key, r);
  }
  return new Set([...latest.values()].map((r) => r.record.id));
}

/** The latest records under each key `keyOf` gives. */
export function latestBy(
  records: ReadRecord[],
  keyOf: (r: ReadRecord) => string | null,
): ReadRecord[] {
  const ids = latestIdsBy(records, keyOf);
  return records.filter((r) => ids.has(r.record.id));
}

/** The ids of `records` that match `keep`. */
export function idsOf(
  records: ReadRecord[],
  keep: (r: ReadRecord) => boolean,
): Set<string> {
  return new Set(records.filter(keep).map((r) => r.record.id));
}

/** The facts a launch carries when it armed a pull request that had no drive ledger. */
export const UNARMED_FACTS = "no ledger, head ";

/**
 * The ids of each pull request's latest re-arm record that carries the heads
 * it launched at: a failed re-arm holds its drive only while it is the latest
 * drive record not cancelled before it ran, as `failedRearm` reads it.
 */
function latestFailedRearms(records: ReadRecord[]): Set<string> {
  const latest = latestDrives(records);
  // A re-arm that ended with exit 0 can never hold its drive, so its row is left to the retention.
  const failed = (r: ReadRecord) =>
    r.record.action === "rearm" &&
    r.record.heads != null &&
    !(r.state.kind === "ended" && r.state.exit.code === 0);
  return idsOf(latest, failed);
}

/**
 * The ids of each pull request's latest drive record (a re-arm or a takeover)
 * when it ended on `drive.ts`'s usage error: the record is the only evidence
 * that the same command line was refused, so it outlives the retention until a
 * later launch supersedes it.
 */
export function latestUsageRefusals(records: ReadRecord[]): Set<string> {
  const latest = latestDrives(records);
  return idsOf(
    latest,
    (r) =>
      r.state.kind === "ended" &&
      r.state.exit.code === DRIVE_EXIT.UNSUPPORTED_CLI,
  );
}

/** Whether a drive record ended the way `repeated-ends.ts` counts: a re-arm that stopped `NOT_SETTLED`, or a takeover that failed on an exit no other rule answers. */
function repeatedEnd(r: ReadRecord): boolean {
  if (r.state.kind !== "ended" || r.record.rearmRequestId != null) return false;
  const { code, signal } = r.state.exit;
  return r.record.action === "rearm"
    ? code === DRIVE_EXIT.NOT_SETTLED
    : r.record.action === "takeover" && failedTakeoverExit(code, signal);
}

/**
 * The ids of each pull request's drive records (re-arms and takeovers, not
 * cancelled before they ran) at the tail of its drive records that ended the
 * way `repeated-ends.ts` counts, as many as its longest cap can count: the only
 * evidence of how many launches in a row ended so, kept until a later launch
 * ends the run.
 */
export function latestRepeatedEnds(records: ReadRecord[]): Set<string> {
  const cap = Math.max(NOT_SETTLED_ENDS_KEPT, FAILED_TAKEOVERS);
  const byPr = new Map<string, ReadRecord[]>();
  for (const r of records) {
    if (!isDrive(r.record.action) || cancelledBeforeExecution(r)) continue;
    const key = `${r.record.repo}#${String(r.record.pr)}`;
    byPr.set(key, [...(byPr.get(key) ?? []), r]);
  }
  const kept = new Set<string>();
  for (const mine of byPr.values()) {
    const newest = [...mine].sort((a, b) =>
      b.record.createdAt.localeCompare(a.record.createdAt),
    );
    let takeovers = false;
    let i = 0;
    for (; i < Math.min(cap, newest.length); i++) {
      const r = newest[i];
      if (r === undefined || !repeatedEnd(r)) break;
      kept.add(r.record.id);
      takeovers ||= r.record.action === "takeover";
    }
    // The drive record that ended the run started the driver the takeovers act on: counting them needs its attribution.
    const owner = newest[i];
    if (takeovers && owner !== undefined) kept.add(owner.record.id);
  }
  return kept;
}

/** The ids of the drive records whose refusal holds their drive: a failed re-arm, a usage refusal and a run of repeated ends. */
export function latestDriveRefusals(records: ReadRecord[]): Set<string> {
  return new Set([
    ...latestFailedRearms(records),
    ...latestUsageRefusals(records),
    ...latestRepeatedEnds(records),
  ]);
}

/**
 * The ids of each pull request's latest arm record per head commit: an arm
 * is not repeated at the same head, and the record is the only evidence of
 * that when the arm left no ledger, so it outlives the retention.
 */
export function latestArms(records: ReadRecord[]): Set<string> {
  return idsOf(
    latestBy(records, (r) =>
      isDrive(r.record.action) && r.record.facts?.startsWith(UNARMED_FACTS)
        ? `${r.record.repo}#${String(r.record.pr)}\0${r.record.facts}`
        : null,
    ),
    () => true,
  );
}
