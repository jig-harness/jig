/**
 * The reset a vendor's usage-limit notice states, as an instant. Claude Code
 * prints the reset in the host's time zone, in two forms:
 *
 * - a time of day, for a window that reopens within a day:
 *   `resets 3:20am (Europe/Amsterdam)`;
 * - a date and a time of day, for a weekly window:
 *   `resets Nov 13, 11am (Europe/Amsterdam)`.
 *
 * Neither carries a year, so each resolves to its next occurrence after
 * the notice was read. The zone in the notice decides; one the notice leaves
 * out is the host's. A reset that does not read, names a zone the runtime does
 * not know, or lands further out than a weekly window can (`MAX_AHEAD_MS`) is
 * `null`, and the caller backs off instead.
 */
import { nextWallClock } from "../../skills/drive-pr/scripts/lib/quota/wallclock.ts";

/** The longest a notice's reset may lie ahead: a weekly window and a day of slack. */
export const MAX_AHEAD_MS = 8 * 24 * 60 * 60_000;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const ZONE = "[A-Za-z0-9+_-]+(?:\\/[A-Za-z0-9+_-]+)*";

/** `resets [<month> <day>,] <hour>[:<minute>][am|pm] [(<zone>)|<zone>]`, the whole clause. */
const RESET_RE = new RegExp(
  `^resets\\s+(?:([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(?:at\\s+)?)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?(?:\\s*(?:\\((${ZONE})\\)|(${ZONE})))?$`,
  "i",
);

/** The month a name or its three-letter abbreviation names, 1 to 12; `null` for anything else. */
function monthOf(name: string): number | null {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex(
    (month) => month === lower || month.slice(0, 3) === lower,
  );
  return index < 0 ? null : index + 1;
}

/** A 12- or 24-hour clock's hour as 0 to 23; `null` when out of range. */
function hourOf(raw: number, meridiem: string | undefined): number | null {
  if (meridiem === undefined) return raw <= 23 ? raw : null;
  if (raw < 1 || raw > 12) return null;
  const base = raw === 12 ? 0 : raw;
  return meridiem.toLowerCase() === "pm" ? base + 12 : base;
}

/**
 * The next instant after `now` that shows `month`-`day` `hour`:`minute` in
 * `zone`: a time the clock skips (a spring-forward gap) does not read, and a
 * time it shows twice (a fall-back) resolves to the first showing not before
 * the current minute.
 */
function nextDated(
  now: Temporal.Instant,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Temporal.Instant | null {
  try {
    const year = now.toZonedDateTimeISO(zone).year;
    // Candidates sit at second 0 of their minute, so compare against the
    // current minute, as the clock-time resolver does: a notice read seconds
    // after the first showing must not slide to the repeated hour's second.
    const flooredNow = Math.floor(now.epochMilliseconds / 60_000) * 60_000;
    for (const y of [year, year + 1]) {
      const wall = Temporal.PlainDateTime.from(
        { year: y, month, day, hour, minute },
        { overflow: "reject" },
      );
      const first = wall.toZonedDateTime(zone, { disambiguation: "earlier" });
      if (first.toPlainDateTime().equals(wall) === false) return null;
      const later = wall.toZonedDateTime(zone, { disambiguation: "later" });
      for (const at of [first.toInstant(), later.toInstant()])
        if (at.epochMilliseconds >= flooredNow) return at;
    }
  } catch (error) {
    // An unknown zone or a date the calendar lacks (Feb 30) does not read.
    if (error instanceof RangeError) return null;
    throw error;
  }
  return null;
}

/**
 * The reset a notice's `resets …` clause states, at or after `now` and no
 * further than `MAX_AHEAD_MS` out; `null` when it does not read.
 */
export function noticeReset(
  clause: string,
  now: Temporal.Instant,
  hostZone: string = Temporal.Now.timeZoneId(),
): Temporal.Instant | null {
  const m = RESET_RE.exec(clause.trim());
  if (m === null) return null;
  const hour = hourOf(Number.parseInt(m[3] as string, 10), m[5]);
  const minute = m[4] === undefined ? 0 : Number.parseInt(m[4], 10);
  if (hour === null || minute > 59) return null;
  const zone = m[6] ?? m[7] ?? hostZone;
  let at: Temporal.Instant | null;
  if (m[1] === undefined) at = nextWallClock(now, hour, minute, zone);
  else {
    const month = monthOf(m[1]);
    const day = Number.parseInt(m[2] as string, 10);
    if (month === null || day < 1 || day > 31) return null;
    at = nextDated(now, month, day, hour, minute, zone);
  }
  if (at === null) return null;
  // The clock-time resolver compares against the floored minute, so a reset
  // already past can come back; a wall at or before now is no wall.
  if (at.epochMilliseconds <= now.epochMilliseconds) return null;
  return at.epochMilliseconds - now.epochMilliseconds <= MAX_AHEAD_MS
    ? at
    : null;
}
