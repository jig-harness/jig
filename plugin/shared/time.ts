/**
 * Time as Jig's code reads and writes it, on the platform's Temporal API
 * (ADR-0018). A moment is a `Temporal.Instant`; the epoch milliseconds and
 * the ISO 8601 strings that records and arithmetic use come from these
 * helpers, so no module builds a `Date` to get them. Code that needs the
 * clock under a test's control takes a `Clock` (clock.ts), whose `now` reads
 * `currentMs`.
 *
 * Two differences from `Date` are absorbed here so a caller does not meet
 * them one at a time:
 *
 * - Strings are written with millisecond precision, as `Date.toISOString`
 *   wrote them. `Temporal.Instant.toString` adds nanosecond digits by
 *   default, which would change every stored record and every comparison
 *   against one.
 * - Parsing reads the ISO 8601 forms Jig meets (see `parseInstant`) and
 *   nothing else. `Date.parse` guessed at other shapes, by the host's time
 *   zone for some of them; a string that is not one of these forms is `NaN`
 *   from `parseMs`, so a caller's `Number.isFinite` guard still holds.
 */

/** The current moment, in whole milliseconds since the epoch. */
export function currentMs(): number {
  return Temporal.Now.instant().epochMilliseconds;
}

/** The current moment as an ISO 8601 string in UTC: `2026-11-12T21:02:36.233Z`. */
export function currentIso(): string {
  return isoFromMs(currentMs());
}

/**
 * `ms` milliseconds since the epoch as an ISO 8601 string in UTC. A fraction
 * is dropped, as `Date` dropped it; `NaN`, an infinity and a moment beyond
 * ±8.64e15 ms throw a `RangeError`, as `Date.toISOString` threw one.
 */
export function isoFromMs(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(Math.trunc(ms)).toString({
    fractionalSecondDigits: 3,
  });
}

/** An instant as an ISO 8601 string in UTC, in milliseconds. */
export function isoOf(instant: Temporal.Instant): string {
  return instant.toString({ fractionalSecondDigits: 3 });
}

// A zone or offset at the end of a string, after any whitespace before it.
const TRAILING_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * Whether `text` carries zone information: after the time, a `Z`, an offset
 * (`+01:00`, `+01:00:30`) or a bracketed annotation (`[Europe/Paris]`), which
 * a date alone can carry too.
 */
function hasZoneMark(text: string): boolean {
  const time = text.search(/T/i);
  if (time >= 0 && /[Z+\-[]/i.test(text.slice(time + 1))) return true;
  return /^\d{4}-\d{2}-\d{2}\[/.test(text);
}

/** `text` without the whitespace between its time and a trailing zone. */
function joinTrailingZone(text: string): string {
  const zone = TRAILING_ZONE.exec(text);
  if (zone === null) return text;
  return text.slice(0, zone.index).trimEnd() + zone[0];
}

/**
 * The instant a string names. It reads ISO 8601 with a `Z` or an offset
 * (`2026-11-12T10:00:00Z`, `…+01:00`, `…+0100`), the same with a space for
 * the `T` and a space before the offset (as `git log --date=iso` prints it),
 * and a date or date-time with no offset, which is UTC. Anything else throws
 * a `RangeError`.
 */
export function parseInstant(value: string): Temporal.Instant {
  const text = joinTrailingZone(
    value.trim().replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T"),
  );
  // Zone information that is present goes to `Instant.from`, which reads it
  // as written and throws when it is wrong or unsupported; only a string
  // with none is UTC (`PlainDateTime.from` would drop it silently).
  if (hasZoneMark(text)) return Temporal.Instant.from(text);
  return Temporal.PlainDateTime.from(text).toZonedDateTime("UTC").toInstant();
}

/**
 * Milliseconds since the epoch for an ISO 8601 string (`parseInstant`), or
 * `NaN` when it is not one: the answer `Date.parse` gave.
 */
export function parseMs(value: string): number {
  try {
    return parseInstant(value).epochMilliseconds;
  } catch {
    return Number.NaN;
  }
}

/**
 * Whether `text` is a date written `YYYY-MM-DD` that the calendar has:
 * `2026-02-30` and `2026-13-01` have the shape and are not.
 */
export function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  try {
    Temporal.PlainDate.from(text, { overflow: "reject" });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const HTTP_DATE =
  /^(?:[A-Z][a-z]{2}), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/**
 * Milliseconds since the epoch for an HTTP date (`Tue, 12 Nov 2026 10:00:00
 * GMT`, the form `Retry-After` and `Date` headers carry), or `NaN`.
 */
export function parseHttpDateMs(value: string): number {
  const match = HTTP_DATE.exec(value.trim());
  const month = match ? MONTHS.indexOf(match[2] as string) + 1 : 0;
  if (!match || month === 0) return Number.NaN;
  try {
    return Temporal.ZonedDateTime.from(
      {
        year: Number(match[3]),
        month,
        day: Number(match[1]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
        timeZone: "UTC",
      },
      { overflow: "reject" },
    ).epochMilliseconds;
  } catch {
    return Number.NaN;
  }
}
