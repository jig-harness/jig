/**
 * A drive's stop in one line, as a person reads it: the Orca card's comment
 * at a stop that needs a person (`orca-card.ts`), and the first part of the
 * closing report's `concluded` (`closing-report.ts`). A park names the first
 * parked item's question and how many more wait; a usage-limit stop names the
 * wall and when it resets; every other exit says what the terminal-state
 * registry's `report.stop` says for it.
 */
import type { DriveState } from "../state/schema.ts";
import { driveExitReport, TERMINAL_STATES } from "../status/terminal-states.ts";

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

/**
 * The line for a drive that stopped with exit `code`. `state` is the drive
 * state, read for a park's question and a usage limit's reset; `null` when
 * it could not be read.
 */
export function stopText(
  pr: string,
  code: number,
  state: DriveState | null,
): string {
  if (code === exitOf("HITL_PARKED")) return parkStop(pr, code, state);
  if (code === exitOf("QUOTA_PARKED")) return quotaStop(pr, code, state);
  const named = driveExitReport(code);
  return named === null
    ? `PR #${pr}'s drive ended with exit ${code}, which names no state the drive ends with`
    : `PR #${pr}'s drive ${named.report.stop} (exit ${code})`;
}
