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
