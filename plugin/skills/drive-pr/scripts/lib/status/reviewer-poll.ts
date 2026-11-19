export const DEFAULT_REVIEWER_POLL_MAX_SECONDS = 300;

/** Double consecutive reviewer waits, preserving a last poll when time permits. */
export function reviewerPollSeconds(
  interval: number,
  max: number,
  previous: number,
  remainingMs: number,
): number {
  return Math.max(
    interval,
    Math.min(previous * 2, max, Math.floor(remainingMs / 1000)),
  );
}
