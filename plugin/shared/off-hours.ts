/**
 * The off-hours schedule: the windows during which `autonomy.off_hours.level`
 * applies instead of the chosen level.
 *
 * A window is written `<days> [<HH:MM>-<HH:MM>]`, or `<HH:MM>-<HH:MM>` alone
 * for every day:
 *
 *   - `<days>` is a day (`Mon`), a range (`Mon-Fri`, or `Fri-Mon`, which wraps
 *     across the end of the week), or such items joined by commas
 *     (`Mon,Wed,Fri-Sat`). Days are the three-letter English abbreviations,
 *     in any letter case.
 *   - Without times, the window is each of those days whole, midnight to
 *     midnight.
 *   - With times, the window opens at the first time on each of those days
 *     and closes at the second; a second time at or before the first closes
 *     it on the next day, so `Mon-Fri 20:00-07:00` is each weekday evening to
 *     the next morning (Friday's runs into Saturday). The days name the day
 *     a window opens, which is how a night is usually spoken of: Monday from
 *     midnight to 07:00 belongs to Sunday's night, and the default schedule
 *     below leaves it out.
 *
 * Times are the machine's local time zone, read from the clock the process
 * runs under, so a window follows daylight-saving changes and a person's own
 * evening wherever the machine is.
 */

/** The schedule in force once `autonomy.off_hours.level` is set and the schedule is not. */
export const DEFAULT_OFF_HOURS_SCHEDULE: readonly string[] = [
  "Mon-Fri 20:00-07:00",
  "Sat-Sun",
];

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** One parsed window: the days it opens on and its minutes past midnight. */
export interface OffHoursWindow {
  /** As written in the configuration, for the source line. */
  text: string;
  /** The days it opens on, `0` for Sunday, as `Date.getDay` counts them. */
  days: ReadonlySet<number>;
  /** Minutes past midnight it opens at; `0` for a whole-day window. */
  start: number;
  /** Minutes it lasts, at most a whole day. */
  length: number;
}

/** A schedule entry that cannot be read as a window. */
export class OffHoursScheduleError extends Error {
  override name = "OffHoursScheduleError";
}

const MINUTES_PER_DAY = 24 * 60;

function dayIndex(name: string, text: string): number {
  const i = (DAYS as readonly string[]).indexOf(name.toLowerCase());
  if (i < 0)
    throw new OffHoursScheduleError(
      `off-hours window "${text}": "${name}" is not a day (Mon, Tue, Wed, Thu, Fri, Sat, Sun)`,
    );
  return i;
}

function parseDays(spec: string, text: string): Set<number> {
  const days = new Set<number>();
  for (const item of spec.split(",")) {
    const [from, to, extra] = item.split("-");
    if (from === undefined || from === "" || extra !== undefined)
      throw new OffHoursScheduleError(
        `off-hours window "${text}": "${item}" is not a day or a range of days`,
      );
    const first = dayIndex(from, text);
    const last = to === undefined ? first : dayIndex(to, text);
    // A range that runs past Saturday wraps to Sunday: `Fri-Mon` is four days.
    for (let d = first; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === last) break;
    }
  }
  return days;
}

function parseTime(time: string, text: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (m === null)
    throw new OffHoursScheduleError(
      `off-hours window "${text}": "${time}" is not a time of day as HH:MM`,
    );
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Parse one schedule entry; throws `OffHoursScheduleError` naming what is wrong. */
export function parseWindow(text: string): OffHoursWindow {
  if (text.trim() === "")
    throw new OffHoursScheduleError("an off-hours window is empty");
  const words = text.trim().split(/\s+/);
  const times = words.length > 0 && /:/.test(words.at(-1) ?? "");
  const daySpec = times ? words.slice(0, -1) : words;
  if (daySpec.length > 1 || (daySpec.length === 0 && !times))
    throw new OffHoursScheduleError(
      `off-hours window "${text}": write it as "<days> [HH:MM-HH:MM]", for example "Mon-Fri 20:00-07:00" or "Sat-Sun"`,
    );
  const days =
    daySpec[0] === undefined
      ? new Set([0, 1, 2, 3, 4, 5, 6])
      : parseDays(daySpec[0], text);
  if (!times) return { text, days, start: 0, length: MINUTES_PER_DAY };
  const [from, to, extra] = (words.at(-1) ?? "").split("-");
  if (from === undefined || to === undefined || extra !== undefined)
    throw new OffHoursScheduleError(
      `off-hours window "${text}": the times must be one range, HH:MM-HH:MM`,
    );
  const start = parseTime(from, text);
  const end = parseTime(to, text);
  // An end at or before the start closes on the next day.
  const length = end > start ? end - start : end + MINUTES_PER_DAY - start;
  return { text, days, start, length };
}

/** Parse a whole schedule; throws on the first entry that cannot be read. */
export function parseSchedule(entries: readonly string[]): OffHoursWindow[] {
  return entries.map(parseWindow);
}

/**
 * The window `at` falls inside, in the machine's local time, or `null`.
 * A window that crossed midnight is found from the day it opened on.
 */
export function windowAt(
  windows: readonly OffHoursWindow[],
  at: Date,
): OffHoursWindow | null {
  const today = at.getDay();
  const minute = at.getHours() * 60 + at.getMinutes();
  for (const w of windows) {
    // Opened today, or opened yesterday and still open past midnight.
    if (w.days.has(today) && minute >= w.start && minute < w.start + w.length)
      return w;
    const yesterday = (today + 6) % 7;
    if (w.days.has(yesterday) && minute + MINUTES_PER_DAY < w.start + w.length)
      return w;
  }
  return null;
}
