export const DEFAULT_REVIEWER_POLL_MAX_SECONDS = 300;

/** Double consecutive reviewer waits, reserving time for the final poll. */
export function reviewerPollSeconds(
  interval: number,
  max: number,
  previous: number,
  remainingMs: number,
): number {
  const usual = Math.max(interval, Math.min(previous * 2, max));
  // A wait that consumes the whole budget returns the report observed before
  // sleeping. Leave one second for the loop to read the reviewer once more.
  return Math.min(usual, Math.max(1, Math.floor(remainingMs / 1000) - 1));
}
