/**
 * How many launches of one drive in a row may end the same way before the
 * drive is a person's (`repeated-ends.ts`). Launch record retention
 * (`launch-keep.ts`) keeps that many records at the tail of a drive, so it
 * reads these without the settlement's imports.
 */
import {
  DRIVE_EXIT,
  DRIVER_REFUSAL_EXITS,
} from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";

/** The re-arms that may stop `NOT_SETTLED` on one head before the drive is a person's. */
export const NOT_SETTLED_REARMS = 3;
/** The takeovers that may fail on one set of ledger facts before the drive is a person's. */
export const FAILED_TAKEOVERS = 3;

/** The exits of a takeover another rule answers: none, a second driver's refusal, the usage error, and the account's or the forge's wall. */
const ANSWERED_ELSEWHERE: ReadonlySet<number> = new Set([
  0,
  DRIVE_EXIT.UNSUPPORTED_CLI,
  DRIVE_EXIT.QUOTA_PARKED,
  DRIVE_EXIT.FORGE_RATE_LIMITED,
  ...DRIVER_REFUSAL_EXITS,
]);

/** Whether a takeover that ended `code` failed in a way no other rule answers, so it counts toward `FAILED_TAKEOVERS`. */
export function failedTakeoverExit(code: number | null): boolean {
  return code !== null && !ANSWERED_ELSEWHERE.has(code);
}
