/**
 * A drive's stop in one line, as a person reads it: the Orca card's comment
 * at a stop that needs a person (`orca-card.ts`), and the first part of the
 * closing report's `concluded` (`closing-report.ts`). A park names the first
 * parked item's question and how many more wait; a usage-limit stop names the
 * wall and when it resets, a stop on the forge's rate limit when that resets;
 * every other exit says what the terminal-state registry's `report.stop` says
 * for it.
 */
import type { DriveState } from "../state/schema.ts";
import { lastStopEvent } from "../state/events.ts";
import { driveExitReport, TERMINAL_STATES } from "../status/terminal-states.ts";
import { driverRuntime } from "./runtime.ts";

/** The exit `drive.ts` ends with for `state`, as the registry gives it. */
export function exitOf(state: string): number | undefined {
  return TERMINAL_STATES[state]?.exitCode;
}

/** One line: newlines and runs of space collapsed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A park's line: the first parked item's question, and how many more wait. */
function parkStop(pr: string, code: number, state: DriveState | null): string {
  const parked = state?.parked ?? [];
  const first = parked[0];
  if (first === undefined)
    return `PR #${pr} parked: a decision waits for a person (exit ${code})`;
  const more =
    parked.length > 1 ? ` (and ${parked.length - 1} more decisions)` : "";
  return `PR #${pr} parked: ${oneLine(first.reason)}${more}`;
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

/** A stop on the forge's rate limit: when it resets, from the stop this driver is recording, else the stop's event. */
function forgeLimitStop(
  pr: string,
  code: number,
  state: DriveState | null,
): string {
  const stop = lastStopEvent(state?.events ?? []);
  const until =
    driverRuntime.stopLimitedUntil ??
    (stop?.cause === String(code) ? stop.until : undefined) ??
    "at an unknown time";
  return `PR #${pr} stopped on the forge's rate limit for its credential, which resets ${until} (exit ${code})`;
}

/**
 * The line for a drive that stopped with exit `code`. `state` is the drive
 * state, read for a park's question and a limit's reset; `null` when it
 * could not be read.
 */
export function stopText(
  pr: string,
  code: number,
  state: DriveState | null,
): string {
  if (code === exitOf("HITL_PARKED")) return parkStop(pr, code, state);
  if (code === exitOf("QUOTA_PARKED")) return quotaStop(pr, code, state);
  if (code === exitOf("FORGE_RATE_LIMITED"))
    return forgeLimitStop(pr, code, state);
  const named = driveExitReport(code);
  return named === null
    ? `PR #${pr}'s drive ended with exit ${code}, which names no state the drive ends with`
    : `PR #${pr}'s drive ${named.report.stop} (exit ${code})`;
}
