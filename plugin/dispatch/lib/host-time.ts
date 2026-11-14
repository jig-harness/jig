/**
 * The host's time zone and its days. The dashboard says "today" and "host
 * time", which must mean the same on a phone and a laptop, and on a server
 * running somewhere else over a copy of the host's database.
 */

/** The zone this process runs in. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `atMs` on `timeZone`'s clock. */
function zoned(timeZone: string, atMs: number): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(atMs).toZonedDateTimeISO(
    timeZone,
  );
}

/**
 * The start of the day `nowMs` falls in on `timeZone`'s clock, `days` days on:
 * its first moment, which is not midnight on a day whose clock change skips
 * midnight.
 */
export function midnightIn(timeZone: string, nowMs: number, days = 0): number {
  return zoned(timeZone, nowMs)
    .toPlainDate()
    .add({ days })
    .toZonedDateTime(timeZone).epochMilliseconds;
}

/** The date `atMs` falls on in `timeZone`: `2026-11-03`. */
export function dateIn(timeZone: string, atMs: number): string {
  return zoned(timeZone, atMs).toPlainDate().toString();
}

/** `atMs` on `timeZone`'s clock to the minute, as a `datetime-local` control writes it: `2026-11-03T16:47`. */
export function wallClockIn(timeZone: string, atMs: number): string {
  return zoned(timeZone, atMs)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}

/**
 * The ISO week `atMs` falls in on `timeZone`'s clock: `2026-W45`. A week runs
 * Monday to Sunday and belongs to the year that holds its Thursday, so the
 * days around a new year can belong to the other year's week.
 */
export function isoWeekIn(timeZone: string, atMs: number): string {
  const date = zoned(timeZone, atMs);
  return `${date.yearOfWeek}-W${String(date.weekOfYear).padStart(2, "0")}`;
}
