/**
 * Guards for the times, zones and spans a stored line carries, shared by the
 * reader that validates a line and the page that formats it, so the two never
 * disagree about which values are usable. The dashboard's page runs this in
 * the browser, so it reads times with `Date` (ADR-0018).
 */

/** A string `Date` can read as a time. */
export function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** A zone the browser can show times in: one its formatter accepts, which is wider than the names it lists. */
export function isZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch (cause) {
    // The formatter names a zone it does not know by a RangeError; any other
    // failure is not an answer about the zone.
    if (!(cause instanceof RangeError)) throw cause;
    return false;
  }
}

/** A span added to a tick's time and formatted: non-negative, and the sum still a time `Intl` can show. */
export function isSpan(startedAt: string, span: unknown): span is number {
  if (typeof span !== "number" || !Number.isFinite(span) || span < 0)
    return false;
  return Number.isFinite(new Date(Date.parse(startedAt) + span).getTime());
}
