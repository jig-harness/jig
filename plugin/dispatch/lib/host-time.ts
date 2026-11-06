/**
 * The host's time zone and its days. The dashboard says "today" and "host
 * time", which must mean the same on a phone and a laptop, and on a server
 * running somewhere else over a copy of the host's database.
 */

/** The zone this process runs in. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** How far `timeZone`'s clock is ahead of UTC at `atMs`. */
function offsetMs(timeZone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(atMs);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const shown = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return shown - Math.floor(atMs / 1000) * 1000;
}

/**
 * The start of the day `nowMs` falls in on `timeZone`'s clock, `days` days on.
 * The offset is read twice since the day's start can stand on the other side of
 * a clock change from `nowMs`.
 */
export function midnightIn(timeZone: string, nowMs: number, days = 0): number {
  const local = new Date(nowMs + offsetMs(timeZone, nowMs));
  const wall = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + days,
  );
  return wall - offsetMs(timeZone, wall - offsetMs(timeZone, wall));
}

/** `atMs` as `timeZone`'s clock shows it, read as if that clock were UTC's. */
function wall(timeZone: string, atMs: number): Date {
  return new Date(atMs + offsetMs(timeZone, atMs));
}

/** The date `atMs` falls on in `timeZone`: `2026-11-03`. */
export function dateIn(timeZone: string, atMs: number): string {
  return wall(timeZone, atMs).toISOString().slice(0, 10);
}

/** `atMs` on `timeZone`'s clock to the minute, as a `datetime-local` control writes it: `2026-11-03T16:47`. */
export function wallClockIn(timeZone: string, atMs: number): string {
  return wall(timeZone, atMs).toISOString().slice(0, 16);
}

/**
 * The ISO week `atMs` falls in on `timeZone`'s clock: `2026-W45`. A week runs
 * Monday to Sunday and belongs to the year that holds its Thursday, so the
 * days around a new year can belong to the other year's week.
 */
export function isoWeekIn(timeZone: string, atMs: number): string {
  const date = wall(timeZone, atMs);
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  const thursday = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 4 - day,
  );
  const year = new Date(thursday).getUTCFullYear();
  const week =
    Math.floor((thursday - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
