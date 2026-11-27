/**
 * A converged head's CI wait polls every few seconds; its line is printed
 * when the wait starts and when what it waits for changes, not on every poll,
 * so a long grace period leaves one line in the driver log, not hundreds.
 * A poll that does not wait ends the wait: the next one that does prints again.
 */

/** The wait line printed by the previous poll, and the one this poll is on. */
export interface WaitLines {
  waitLinePrinted?: string | null;
  waitLineNow?: string | null;
}

/** Start a poll: what the previous one waited on is what this one compares against. */
export function nextWaitPoll(state: WaitLines): void {
  state.waitLinePrinted = state.waitLineNow ?? null;
  state.waitLineNow = null;
}

/**
 * Say this poll waits, printing `line` unless the previous poll waited on the
 * same thing: `key` names it (the head and what it waits for), and defaults
 * to the line itself.
 */
export function sayWaiting(
  state: WaitLines,
  line: string,
  key: string = line,
): void {
  state.waitLineNow = key;
  if (state.waitLinePrinted !== key) console.error(line);
}
