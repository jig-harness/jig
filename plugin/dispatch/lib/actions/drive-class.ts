import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { LaunchRecord } from "../launches.ts";
import { RECOVERY_FACTS } from "../recovery-facts.ts";
import type { DrivenPr, LedgerClass, StaleCause } from "../types.ts";
import { armsUnarmed } from "./drive-hold.ts";

/** Why a pending record's launch no longer acts on the class its ledger reads now, by the class alone. */
export function classChanged(
  record: LaunchRecord,
  read: DrivenPr,
): string | null {
  const takeover = record.action === "takeover";
  const want = wantedClass(takeover, record.redrive, record.facts);
  // A pending conflict repair still owns its launch when the park's answers
  // or mergeability change. Replay under the same token instead of leaving
  // the pending record holding the park's ordinary re-arm forever.
  const parkedReplay =
    record.redrive?.conflictStop === true &&
    read.evidence.exit === DRIVE_EXIT.HITL_PARKED &&
    (read.class === "parked" || read.class === "re-armable");
  if (read.class !== want && !parkedReplay)
    return `its ledger now reads ${read.class}`;
  const gone =
    takeover &&
    record.replaces === null &&
    record.facts.startsWith(RECOVERY_FACTS);
  return gone && read.evidence.driverGone !== true
    ? `this host no longer shows its driver's run ended: ${String(read.evidence.driverCheck)}`
    : null;
}

/** The class a launch acts on: a takeover's `silent`, a re-drive's `stale`, a labelled arm's `unarmed`, any other re-arm's `re-armable`. */
export function wantedClass(
  takeover: boolean,
  redrive: StaleCause | null | undefined,
  facts: string | null | undefined,
): LedgerClass {
  if (takeover) return "silent";
  if (armsUnarmed(facts)) return "unarmed";
  return redrive == null ? "re-armable" : "stale";
}

/** Why a pull request no longer shows the change a re-drive acts on; `null` when it still does. */
export function changedStale(
  redrive: StaleCause | null | undefined,
  fresh: DrivenPr,
): string | null {
  if (redrive == null || fresh.stale?.change === redrive.change) return null;
  return `its pull request changed since the plan read it (now ${fresh.stale?.cause ?? fresh.why})`;
}
