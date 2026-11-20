/** The read that failed beside an unplaced ledger: its park's answers or its base branch's head. */
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { combinedFailure } from "../read-failures.ts";
import type { ReadFailure } from "../types.ts";
import { classed } from "./base-heads.ts";
import type { PrFacts } from "./ledgers.ts";
import type { ParkReading } from "./park-reading.ts";

/**
 * The read that failed beside an unplaced ledger, its park's answers or its
 * base branch's head, with the class of the call that failed it; nothing
 * when neither failed.
 */
export function failedRead(
  ledger: Ledger,
  park: ParkReading | undefined,
  forge: PrFacts,
): { readFailed?: true; failure?: ReadFailure } {
  const failed: (ReadFailure | undefined)[] = [];
  const parkFailed =
    ledger.driver.exit === DRIVE_EXIT.HITL_PARKED &&
    (park === undefined || "unreadable" in park);
  if (parkFailed) failed.push(park?.failure);
  const baseFailed = forge.base !== undefined && "unreadable" in forge.base;
  if (forge.base !== undefined && "unreadable" in forge.base)
    failed.push(forge.base.failure);
  if (failed.length === 0) return {};
  const failure = combinedFailure(failed);
  // The park's reading marks an absence (`park-reading.ts`); a base branch's head that failed beside it is no absence, so the mark does not carry.
  const { absence: _absence, ...unmarked } = failure ?? {};
  return {
    readFailed: true,
    ...classed(
      failure === undefined
        ? undefined
        : baseFailed || failure.absence !== true
          ? (unmarked as ReadFailure)
          : failure,
    ),
  };
}
