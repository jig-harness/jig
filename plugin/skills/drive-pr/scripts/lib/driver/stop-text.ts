/**
 * A drive's stop in one line, as a person reads it: the Orca card's comment
 * at a stop that needs a person (`orca-card.ts`), and the first part of the
 * closing report's `concluded` (`closing-report.ts`). A park names the first
 * parked item's question and how many more wait; a usage-limit stop names the
 * wall and when it resets; a check-runs listing cut short names the pages it
 * read; every other exit says what the terminal-state registry's
 * `report.stop` says for it.
 */
import type { ParkedItem } from "../state/park-frame.ts";
import type { DriveState } from "../state/schema.ts";
import {
  diagnosisDetail,
  latestDiagnosedParkKey,
} from "../state/ci-actions.ts";
import { lastStopEvent, stopInstant } from "../state/events.ts";
import {
  DRIVE_EXIT,
  driveExitReport,
  TERMINAL_STATES,
} from "../status/terminal-states.ts";
import { driverRuntime } from "./runtime.ts";

/** The exit `drive.ts` ends with for `state`, as the registry gives it. */
export function exitOf(state: string): number | undefined {
  return TERMINAL_STATES[state]?.exitCode;
}

/** One line: newlines and runs of space collapsed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The parked item a park's stop prints: the one the head's diagnosis handed
 * to a person, else the first.
 */
export function leadPark(state: DriveState | null): ParkedItem | undefined {
  const parked = state?.parked ?? [];
  const key = latestDiagnosedParkKey(state?.ciActions ?? []);
  return parked.find((p) => p.key === key) ?? parked[0];
}

/** A park's line: the first parked item's question, and how many more wait. */
function parkStop(pr: string, code: number, state: DriveState | null): string {
  const parked = state?.parked ?? [];
  const first = leadPark(state);
  const probe = driverRuntime.stopProbe;
  const prefix =
    probe?.code === code
      ? ` stopped at ${probe.state} (exit ${code}): ${probe.reason};`
      : ":";
  if (first === undefined)
    return `PR #${pr} parked${prefix} a decision waits for a person (exit ${code})`;
  const more =
    parked.length > 1 ? ` (and ${parked.length - 1} more decisions)` : "";
  return `PR #${pr} parked${prefix} ${oneLine(first.reason)}${more}`;
}

/** A usage-limit stop's line: the wall, and when it resets. */
function quotaStop(pr: string, code: number, state: DriveState | null): string {
  const park = state?.quotaPark ?? null;
  const wall =
    park === null
      ? "a usage limit"
      : `a ${oneLine(park.vendor)} ${oneLine(park.window)}-window usage limit`;
  const reset = park?.resetAt == null ? "at an unknown time" : park.resetAt;
  return `PR #${pr} stopped on ${wall}, which resets ${reset} (exit ${code})`;
}

/** What held a stall's rounds: the `finish-round.ts` state its passes all ended on. */
export interface StallFinish {
  state: string;
  reason: string;
}

/** A stop on the forge's rate limit: when it resets, from the stop this driver is recording, else the stop's event. */
function forgeLimitStop(
  pr: string,
  code: number,
  state: DriveState | null,
): string {
  const stop = lastStopEvent(state?.events ?? []);
  const until =
    driverRuntime.stopLimitedUntil ??
    (stop?.cause === String(code) ? stopInstant(stop) : undefined) ??
    "at an unknown time";
  const probe = driverRuntime.stopProbe;
  const reason = probe?.code === code ? `: ${probe.reason}` : "";
  return `PR #${pr} stopped on the forge's rate limit for its credential, which resets ${until}${reason} (exit ${code})`;
}

/**
 * The line for a drive that stopped with exit `code`. `state` is the drive
 * state, read for a park's question and a limit's reset; `null` when it
 * could not be read. `stall` is what held a stall's rounds, when its passes
 * agree on it.
 */
export function stopText(
  pr: string,
  code: number,
  state: DriveState | null,
  stall: StallFinish | null = null,
): string {
  if (code === exitOf("HITL_PARKED")) return parkStop(pr, code, state);
  if (code === exitOf("QUOTA_PARKED")) return quotaStop(pr, code, state);
  if (code === exitOf("CI_REPAIR_SPENT")) {
    const diagnosis = diagnosisDetail(state?.ciActions ?? []);
    if (diagnosis !== undefined)
      return `PR #${pr} stopped after diagnosing CI (exit ${code}): ${diagnosis}`;
  }
  if (code === exitOf("STALLED") && stall !== null)
    return `PR #${pr}'s drive stalled: every stalled pass's round ended ${stall.state}: ${oneLine(stall.reason)} (exit ${code})`;
  if (code === exitOf("FORGE_RATE_LIMITED"))
    return forgeLimitStop(pr, code, state);
  const probe = driverRuntime.stopProbe;
  if (probe?.code === code)
    return `PR #${pr} stopped at ${probe.state} (exit ${code}): ${probe.reason}`;
  const named = driveExitReport(code);
  if (named === null)
    return `PR #${pr}'s drive ended with exit ${code}, which names no state the drive ends with`;
  const pages = driverRuntime.stopListingPages;
  const read =
    code === DRIVE_EXIT.CHECK_RUNS_UNREADABLE && pages !== null
      ? ` after ${pages} page(s)`
      : "";
  return `PR #${pr}'s drive ${named.report.stop}${read} (exit ${code})`;
}
