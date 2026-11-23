/**
 * Resolve a bare wall-clock time in a named IANA zone to an absolute instant.
 *
 * This exists for exactly one input shape, and it is a bad one that the vendor
 * chose, not us: Claude Code announces its usage wall as
 * `resets 3:20am (Europe/Amsterdam)` — a time of day, a zone, and NO DATE. To
 * decide whether a drive may sleep through it, the driver needs an instant.
 *
 * The rules that make that resolvable without a date:
 *
 *   1. The reset is in the FUTURE. So the answer is the next occurrence of that
 *      wall clock in that zone at or after `now`: today's if it has not passed,
 *      otherwise tomorrow's.
 *   2. The caller BOUNDS the result before acting on it. A five-hour window
 *      that resolves 23 hours out means rule 1 picked the wrong day (or the
 *      wording was not what we thought), and the caller's bound rejects it
 *      rather than sleeping. This function is deliberately not the place that
 *      decides plausibility — it reports what the text says.
 *
 * No date library: Temporal's `ZonedDateTime` carries the zone database, and
 * it is enough. It also says, for a wall clock on a transition day, which
 * instants show it: none on a spring-forward (the clock skips it), two on a
 * fall-back (the clock shows it twice), which is precisely the night a
 * five-hour sleep is most likely to cross.
 */

/** Whether `hour:minute` is a clock time. */
function validClock(hour: number, minute: number): boolean {
  return (
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59
  );
}

/**
 * `now` seen in `timeZone`, with `now` floored to its minute; `null` when the
 * zone is unknown (Temporal throws RangeError for one, which is "cannot
 * resolve", this module's null, not an error for a caller mid-diagnosis).
 *
 * Every "has this candidate already passed" decision compares against the
 * FLOORED value, never against `now` directly: a candidate is always
 * constructed at second 0 of its target minute, so an instant-precision
 * comparison rejects one seconds into the SAME minute as already past. That
 * holds for a caller's "at or after" decision and for `occurrence`'s own,
 * which decides whether to take a fall-back transition's LATER occurrence.
 * Left at full precision there, a genuinely valid FIRST occurrence a few
 * seconds into the current minute (during a fall-back's doubled hour) is
 * wrongly treated as passed and swapped for the second, later one instead —
 * sleeping roughly an extra hour.
 */
function zoned(
  now: Temporal.Instant,
  timeZone: string,
): { here: Temporal.ZonedDateTime; floor: number } | null {
  try {
    return {
      here: now.toZonedDateTimeISO(timeZone),
      floor: Math.floor(now.epochMilliseconds / 60_000) * 60_000,
    };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * The instant `wall` names in `timeZone`, judged against `floor`: `null` when
 * the clock skips it (a spring-forward day — e.g. Europe/Amsterdam has no
 * 02:30 on its transition date — where the instant Temporal picks shows some
 * OTHER local time, which is never handed to a caller that could sleep
 * against it); its earlier occurrence when that is not yet past; else its
 * later one. A fall-back transition shows one wall clock TWICE, and when the
 * first has passed the second can still be minutes away — skipping it would
 * advance a whole day past an instant that is actually imminent.
 */
function occurrence(
  wall: Temporal.PlainDateTime,
  timeZone: string,
  floor: number,
): Temporal.Instant | null {
  const earlier = wall.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  if (!earlier.toPlainDateTime().equals(wall)) return null;
  if (earlier.epochMilliseconds >= floor) return earlier.toInstant();
  return wall
    .toZonedDateTime(timeZone, { disambiguation: "later" })
    .toInstant();
}

/** Whether `at` is an instant at or after `floor`. */
function ahead(
  at: Temporal.Instant | null,
  floor: number,
): at is Temporal.Instant {
  return at !== null && at.epochMilliseconds >= floor;
}

/**
 * The next instant at or after `now` whose wall clock in `timeZone` reads
 * `hour:minute`. `null` when the zone is unknown.
 *
 * "At or after" rather than "strictly after" so a reset announced for the
 * current minute resolves to now rather than being pushed a whole day out —
 * the caller's bound is what rejects an implausible answer, and a 24-hour
 * error is exactly the kind this function must not manufacture.
 */
export function nextWallClock(
  now: Temporal.Instant,
  hour: number,
  minute: number,
  timeZone: string,
): Temporal.Instant | null {
  if (!validClock(hour, minute)) return null;
  const at = zoned(now, timeZone);
  if (at === null) return null;
  // Resolve a candidate date (zone-local Y/M/D + the target time).
  const on = (dayShift: number): Temporal.Instant | null =>
    occurrence(
      at.here
        .toPlainDate()
        .add({ days: dayShift })
        .toPlainDateTime({ hour, minute }),
      timeZone,
      at.floor,
    );
  const today = on(0);
  return ahead(today, at.floor) ? today : on(1);
}

/**
 * Parse the `resets <clock> (<zone>)` tail of a vendor's wall message.
 *
 * Tolerates every spelling observed in this machine's transcripts —
 * `resets 10pm (Europe/Amsterdam)`, `resets 3:20am (Europe/Amsterdam)`,
 * `resets 11:40pm Europe/Amsterdam` (no parentheses) — and returns `null` on
 * anything else rather than guessing. A `null` here is not a failure of
 * detection: the block is still recognised, it just cannot be slept through,
 * which routes it to the stop-and-notify branch.
 */
// Exported so a caller that must recognise a WHOLE notice — not merely find a
// reset clause inside one — can compose its own anchored regex from this SAME
// source rather than hand-copying the pattern, which is what let the clause's
// own shape drift out of sync the one time it was duplicated (the Claude
// adapter's session-limit notice matcher — see its own comment for why a
// hand-copied fragment there kept leaving a new bypass position open).
//
// The zone's parentheses are `\(zone\)` OR `zone` — an alternation, not
// `\(?zone\)?`, whose two `?`s are independently optional and therefore also
// accept the mismatched `(zone` and `zone)`. That mismatch was harmless while
// this regex only ever searched loosely for a clause to report as evidence, but
// the Claude adapter now embeds it inside an ANCHORED, fail-closed notice
// matcher — there, accepting a malformed clause means classifying a malformed
// notice as a trusted, sleepable short window instead of taking the
// QUOTA_PARKED path. The alternation puts the zone text in whichever capture
// group corresponds to the branch that matched — group 4 (parenthesized) or
// group 5 (bare) — both read by every caller below.
export const RESET_CLAUSE_RE =
  /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z0-9+_-]+(?:\/[A-Za-z0-9+_-]+)*)\)|([A-Za-z0-9+_-]+(?:\/[A-Za-z0-9+_-]+)*))/i;

/**
 * The `resets ...` substring `parseResetClause` recognises, with none of the
 * surrounding free text — for a caller that wants to record what was RECOGNISED
 * (e.g. as log/evidence text) without storing the raw message it was found in,
 * which can carry unrelated content the vendor happened to bundle alongside its
 * own rate-limit line. `null` on no match, exactly like `parseResetClause`
 * itself.
 */
export function matchResetClauseText(text: string): string | null {
  return RESET_CLAUSE_RE.exec(text)?.[0] ?? null;
}

export function parseResetClause(
  text: string,
  now: Temporal.Instant,
): { at: Temporal.Instant; zone: string } | null {
  // Slash-separated segments are optional for zones such as UTC and GMT.
  // Preserve digits in zone names such as EST5EDT and Etc/GMT+5; resolve the
  // complete name through Temporal rather than interpreting a truncated
  // prefix. Runtime zone support varies, so a name it rejects remains
  // unresolved.
  const m = RESET_CLAUSE_RE.exec(text);
  if (m === null) return null;
  const rawHour = Number.parseInt(m[1] as string, 10);
  const minute = m[2] === undefined ? 0 : Number.parseInt(m[2], 10);
  const meridiem = m[3]?.toLowerCase();
  // Group 4 matched a parenthesized zone, group 5 a bare one — whichever
  // branch of RESET_CLAUSE_RE's alternation matched leaves the other `undefined`.
  const zone = (m[4] ?? m[5]) as string;

  // A 24-hour spelling is accepted, an out-of-range one is not.
  const hour = hourOf(rawHour, meridiem);
  if (hour === null) return null;

  const at = nextWallClock(now, hour, minute, zone);
  return at === null ? null : { at, zone };
}

/**
 * The `resets <month> <day>, <clock> (<zone>)` tail of a wall that reopens
 * days away: Claude Code's weekly notice reads
 * `resets Nov 27, 11am (Europe/Amsterdam)`. A month (its three-letter
 * abbreviation or its full English name), a day of the month, an optional
 * comma, then the same clock and zone `RESET_CLAUSE_RE` reads, with the same
 * parenthesis alternation. Exported for the same reason that one is: a caller
 * anchoring a whole notice composes its regex from this source.
 */
export const DATED_RESET_CLAUSE_RE =
  /resets\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z0-9+_-]+(?:\/[A-Za-z0-9+_-]+)*)\)|([A-Za-z0-9+_-]+(?:\/[A-Za-z0-9+_-]+)*))/i;

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

/** The month a name or its three-letter abbreviation names, 1 to 12; `null` for anything else. */
export function monthOf(name: string): number | null {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex(
    (month) => month === lower || month.slice(0, 3) === lower,
  );
  return index < 0 ? null : index + 1;
}

/** A 12- or 24-hour clock's hour as 0 to 23; `null` when out of range. */
export function hourOf(
  raw: number,
  meridiem: string | undefined,
): number | null {
  if (meridiem === undefined) return raw <= 23 ? raw : null;
  if (raw < 1 || raw > 12) return null;
  const base = raw === 12 ? 0 : raw;
  return meridiem.toLowerCase() === "pm" ? base + 12 : base;
}

/**
 * The next instant at or after `now` (floored to its minute, as
 * `nextWallClock` floors) whose wall clock in `timeZone` reads that month,
 * day and time: this year's, else next year's. `null` when the zone is
 * unknown, the date does not exist (`Feb 30`), or the clock is skipped on
 * that date by a spring-forward transition. A fall-back day's doubled hour
 * takes its first occurrence still ahead.
 */
export function nextDatedWallClock(
  now: Temporal.Instant,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Temporal.Instant | null {
  if (!validClock(hour, minute)) return null;
  const at = zoned(now, timeZone);
  if (at === null) return null;
  for (const year of [at.here.year, at.here.year + 1]) {
    const wall = plainDateTime(year, month, day, hour, minute);
    if (wall === null) return null;
    const found = occurrence(wall, timeZone, at.floor);
    // A time the clock skips on that date does not read.
    if (found === null) return null;
    if (ahead(found, at.floor)) return found;
  }
  return null;
}

/** That date and time, or `null` when the date does not exist (`Feb 30`). */
function plainDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Temporal.PlainDateTime | null {
  try {
    return Temporal.PlainDateTime.from(
      { year, month, day, hour, minute },
      { overflow: "reject" },
    );
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * Parse a dated reset clause (`DATED_RESET_CLAUSE_RE`) to the instant it
 * names, the next one at or after `now`. `null` on anything it cannot
 * resolve, never a guess: the caller then treats the wall as one whose reset
 * is unknown.
 */
export function parseDatedResetClause(
  text: string,
  now: Temporal.Instant,
): { at: Temporal.Instant; zone: string } | null {
  const m = DATED_RESET_CLAUSE_RE.exec(text);
  if (m === null) return null;
  const month = monthOf((m[1] as string).replace(/^sept$/i, "sep"));
  const day = Number.parseInt(m[2] as string, 10);
  const hour = hourOf(Number.parseInt(m[3] as string, 10), m[5]);
  const minute = m[4] === undefined ? 0 : Number.parseInt(m[4], 10);
  const zone = (m[6] ?? m[7]) as string;
  if (month === null || hour === null) return null;
  const at = nextDatedWallClock(now, month, day, hour, minute, zone);
  return at === null ? null : { at, zone };
}

/** The dated `resets ...` substring `parseDatedResetClause` reads, or `null`. */
export function matchDatedResetClauseText(text: string): string | null {
  return DATED_RESET_CLAUSE_RE.exec(text)?.[0] ?? null;
}
