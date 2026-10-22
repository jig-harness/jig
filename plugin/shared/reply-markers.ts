/** Durable reply dispositions shared by the thread writer and drive readers. */
export const LEAVE_OPEN_MARKER = "<!-- triage-thread:leave-open -->";
export const NO_OUTCOME_MARKER = "<!-- reply-to-thread:no-outcome -->";
export const LEAVE_OPEN_MARKER_PRODUCER_ENV =
  "DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER";

/**
 * A marker is the body's exact last nonblank line. Whitespace-only lines may
 * follow it and CRLF line endings are accepted. An indented or padded marker
 * is a quoted example, so it cannot certify a disposition.
 *
 * These markers record a posting choice; they do not authenticate its author.
 * The writer requires the producer flag before posting a leave-open marker,
 * and appends the no-outcome marker itself for explicit clarifying questions.
 */
function hasTrailingMarker(body: string, marker: string): boolean {
  const lines = body.split("\n");
  let index = lines.length - 1;
  while (index >= 0 && lines[index]?.replace(/\r$/, "").trim() === "") index--;
  return index >= 0 && lines[index]?.replace(/\r$/, "") === marker;
}

export const hasLeaveOpenMarker = (body: string): boolean =>
  hasTrailingMarker(body, LEAVE_OPEN_MARKER);
export const hasNoOutcomeMarker = (body: string): boolean =>
  hasTrailingMarker(body, NO_OUTCOME_MARKER);
