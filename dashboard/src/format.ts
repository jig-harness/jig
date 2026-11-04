/**
 * Times and spans as the page shows them: every clock in the host's time zone,
 * every age counted from the server's clock, so a phone whose own clock or zone
 * is off still reads right.
 */

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

const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const known = formatters.get(timeZone);
  if (known !== undefined) return known;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  formatters.set(timeZone, made);
  return made;
}

interface HostTime {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function hostTime(ms: number, timeZone: string): HostTime {
  const out: HostTime = { year: "", month: "", day: "", hour: "", minute: "" };
  for (const part of formatter(timeZone).formatToParts(ms))
    if (part.type in out) out[part.type as keyof HostTime] = part.value;
  return out;
}

/** `16:45`. */
export function clock(ms: number, timeZone: string): string {
  const t = hostTime(ms, timeZone);
  return `${t.hour}:${t.minute}`;
}

/** The day a time falls on in the host's zone, as a key to compare days with: `2026-11-03`. */
export function hostDay(ms: number, timeZone: string): string {
  const t = hostTime(ms, timeZone);
  return `${t.year}-${t.month}-${t.day}`;
}

/** A clock for today, a month, day and clock for any other day: `Oct 4 16:47`. */
export function stamp(ms: number, today: string, timeZone: string): string {
  const t = hostTime(ms, timeZone);
  const time = `${t.hour}:${t.minute}`;
  return hostDay(ms, timeZone) === today
    ? time
    : `${MONTHS[Number(t.month) - 1]} ${Number(t.day)} ${time}`;
}

/** The value a `datetime-local` control shows for a time, in the host's zone: `2026-11-03T16:45`. */
export function inputOf(ms: number, timeZone: string): string {
  const t = hostTime(ms, timeZone);
  return `${t.year}-${t.month}-${t.day}T${t.hour}:${t.minute}`;
}

/** How far a zone's clock stands ahead of UTC at a moment, to the minute. */
function offsetMs(timeZone: string, atMs: number): number {
  const t = hostTime(atMs, timeZone);
  const shown = Date.UTC(
    Number(t.year),
    Number(t.month) - 1,
    Number(t.day),
    Number(t.hour),
    Number(t.minute),
  );
  return shown - Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The instant a `datetime-local` value names on a zone's clock, as ISO text;
 * `null` for text not in that form. The offset is read twice since the first
 * guess can stand on the other side of a clock change from the answer.
 */
export function instantOf(wall: string, timeZone: string): string | null {
  const found = WALL_CLOCK.exec(wall);
  if (found === null) return null;
  const [year, month, day, hour, minute] = found.slice(1).map(Number);
  const asUtc = Date.UTC(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
  );
  const offset = offsetMs(timeZone, asUtc - offsetMs(timeZone, asUtc));
  return new Date(asUtc - offset).toISOString();
}

/** A number of whole minutes as the page says it: `47 min`, `1 h 17 min`, `3 d`. */
export function span(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours >= 48) return `${Math.floor(hours / 24)} d`;
  return `${hours} h${rest > 0 ? ` ${rest} min` : ""}`;
}

/** How long ago a time was: whole minutes that have fully passed. */
export function ago(thenMs: number, nowMs: number): string {
  return span((nowMs - thenMs) / MINUTE_MS);
}

/** How long until a time: a part of a minute still to wait counts as a minute. */
export function until(thenMs: number, nowMs: number): string {
  return span(Math.ceil((thenMs - nowMs) / MINUTE_MS));
}

/** A length in milliseconds as a span. */
export function lengthOf(ms: number): string {
  return span(ms / MINUTE_MS);
}

/** `1 session`, `3 sessions`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The server's clock now: what it said at the read, plus the time since that
 * read on this device's own running clock, which a wrong wall clock does not
 * touch.
 */
export function serverNow(
  saidAt: string,
  readAtMono: number,
  monoNow: number,
): number {
  return Date.parse(saidAt) + Math.max(0, monoNow - readAtMono);
}
