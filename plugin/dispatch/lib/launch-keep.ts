/** Which launch records pruning keeps as the only evidence of what was already done. */
import { cancelledBeforeExecution } from "./cancellation.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { ReadRecord } from "./launches.ts";

const isDrive = (action: string): boolean =>
  action === "rearm" || action === "takeover";

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

/** The facts a launch carries when it armed a pull request that had no drive ledger. */
export const UNARMED_FACTS = "no ledger, head ";

/**
 * The ids of each pull request's latest re-arm record that carries the heads
 * it launched at: a failed re-arm holds its drive only while it is the latest
 * drive record not cancelled before it ran, as `failedRearm` reads it.
 */
function latestFailedRearms(records: ReadRecord[]): Set<string> {
  const latest = latestIdsBy(records, (r) =>
    isDrive(r.record.action) && !cancelledBeforeExecution(r)
      ? `${r.record.repo}#${String(r.record.pr)}`
      : null,
  );
  // A re-arm that ended with exit 0 can never hold its drive, so its row is left to the retention.
  const failed = (r: ReadRecord) =>
    r.record.action === "rearm" &&
    r.record.heads != null &&
    !(r.state.kind === "ended" && r.state.exit.code === 0);
  return new Set(
    records
      .filter((r) => latest.has(r.record.id) && failed(r))
      .map((r) => r.record.id),
  );
}

/**
 * The ids of each pull request's latest drive record (a re-arm or a takeover)
 * when it ended on `drive.ts`'s usage error: the record is the only evidence
 * that the same command line was refused, so it outlives the retention until a
 * later launch supersedes it.
 */
export function latestUsageRefusals(records: ReadRecord[]): Set<string> {
  const latest = latestIdsBy(records, (r) =>
    isDrive(r.record.action) && !cancelledBeforeExecution(r)
      ? `${r.record.repo}#${String(r.record.pr)}`
      : null,
  );
  return new Set(
    records
      .filter(
        (r) =>
          latest.has(r.record.id) &&
          r.state.kind === "ended" &&
          r.state.exit.code === DRIVE_EXIT.UNSUPPORTED_CLI,
      )
      .map((r) => r.record.id),
  );
}

/** The ids of the drive records whose refusal holds their drive: a failed re-arm and a usage refusal. */
export function latestDriveRefusals(records: ReadRecord[]): Set<string> {
  return new Set([
    ...latestFailedRearms(records),
    ...latestUsageRefusals(records),
  ]);
}

/**
 * The ids of each pull request's latest arm record per head commit: an arm
 * is not repeated at the same head, and the record is the only evidence of
 * that when the arm left no ledger, so it outlives the retention.
 */
export function latestArms(records: ReadRecord[]): Set<string> {
  return latestIdsBy(records, (r) =>
    isDrive(r.record.action) && r.record.facts?.startsWith(UNARMED_FACTS)
      ? `${r.record.repo}#${String(r.record.pr)}\0${r.record.facts}`
      : null,
  );
}
