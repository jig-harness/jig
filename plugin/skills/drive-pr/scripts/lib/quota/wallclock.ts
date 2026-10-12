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
 * No date library: `Intl.DateTimeFormat` with a `timeZone` is the only zone
 * database available to both runtimes, and it is enough. The offset is
 * recovered by asking what wall clock the zone shows at a known instant, then
 * inverted — applied twice, because the offset at the ANSWER can differ from
 * the offset at `now` across a DST boundary, which is precisely the night a
 * five-hour sleep is most likely to cross.
 *
 * Runs under Bun and Node >= 22.18: `node:` APIs only, erasable syntax only.
 */

/** Zone-shown wall clock at `instant`, as the numbers a formatter reports. */
interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(instant: Date, timeZone: string): Parts | null {
  let formatted: Intl.DateTimeFormatPart[];
  try {
    formatted = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
  } catch {
    // An unknown zone name throws RangeError. That is "cannot resolve", which
    // is this module's null, not an error for a caller mid-diagnosis to catch.
    return null;
  }
  const get = (type: string): number => {
    const p = formatted.find((x) => x.type === type);
    return p === undefined ? Number.NaN : Number.parseInt(p.value, 10);
  };
  const out = {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // `hour12: false` renders midnight as `24` in some ICU versions and `00` in
    // others. Both mean "the zeroth hour of this day" — the date parts already
    // name the day — so fold it rather than letting a `24` become tomorrow.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
  for (const v of Object.values(out)) if (!Number.isFinite(v)) return null;
  return out;
}

/**
 * Offset in ms such that `wallClockAsUTC - instant === offset` for `timeZone`.
 * East of Greenwich is positive.
 */
function offsetMs(instant: Date, timeZone: string): number | null {
  const p = partsIn(instant, timeZone);
  if (p === null) return null;
  const asUTC = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  // Floor the reference to the second before differencing. The formatter's
  // finest field is the second, so `asUTC` carries no milliseconds while
  // `instant` does — differencing them raw folds that remainder into the
  // "offset" and back out into every resolved reset time, which then reads as
  // 16:40:00.884Z rather than 16:40:00Z. Harmless arithmetically, wrong in
  // every log line and diff it appears in.
  return asUTC - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The next instant at or after `now` whose wall clock in `timeZone` reads
 * `hour:minute`. `null` when the zone is unknown or the formatter is unusable.
 *
 * "At or after" rather than "strictly after" so a reset announced for the
 * current minute resolves to now rather than being pushed a whole day out —
 * the caller's bound is what rejects an implausible answer, and a 24-hour
 * error is exactly the kind this function must not manufacture.
 */
export function nextWallClock(
  now: Date,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  const here = partsIn(now, timeZone);
  if (here === null) return null;

  // Every "has this candidate already passed" decision in this function
  // compares against this FLOORED value, never against `now` directly: a
  // candidate is always constructed at second 0 of its target minute, so an
  // instant-precision comparison rejects one seconds into the SAME minute as
  // already past — an earlier fix covered this for the OUTER "at or after"
  // decision below, but missed the IDENTICAL comparison inside `resolve()`
  // itself, which decides whether to seek a fall-back-transition's LATER
  // occurrence. Left at full precision there, a genuinely valid FIRST
  // occurrence a few seconds into the current minute (during a fall-back's
  // doubled hour) is wrongly treated as passed and swapped for the second,
  // later occurrence instead — sleeping roughly an extra hour.
  const nowFlooredToMinute = Math.floor(now.getTime() / 60_000) * 60_000;

  // Resolve a candidate date (zone-local Y/M/D + the target time) to an
  // instant. Pass 1 uses the offset at `now`; pass 2 re-reads the offset at
  // pass 1's answer, which is what makes a DST-crossing result correct.
  const resolve = (dayShift: number): Date | null => {
    const localAsUTC = Date.UTC(
      here.year,
      here.month - 1,
      here.day + dayShift,
      hour,
      minute,
      0,
    );
    const first = offsetMs(now, timeZone);
    if (first === null) return null;
    const guess = new Date(localAsUTC - first);
    const second = offsetMs(guess, timeZone);
    if (second === null) return null;
    const candidate = new Date(localAsUTC - second);

    // The two-pass correction assumes the requested wall clock actually
    // exists in this zone. On a spring-forward day it does not — e.g.
    // Europe/Amsterdam has no 02:30 on its transition date — and the
    // corrected instant then lands on some OTHER local time, not the one
    // asked for. Round-trip the candidate and refuse rather than hand the
    // caller a fabricated deadline it could sleep against.
    const target = new Date(localAsUTC);
    const roundTrips = (instant: Date): boolean => {
      const shown = partsIn(instant, timeZone);
      return (
        shown !== null &&
        shown.year === target.getUTCFullYear() &&
        shown.month === target.getUTCMonth() + 1 &&
        shown.day === target.getUTCDate() &&
        shown.hour === target.getUTCHours() &&
        shown.minute === target.getUTCMinutes()
      );
    };
    if (!roundTrips(candidate)) return null;

    // A fall-back transition means one local wall clock occurs TWICE. If
    // `candidate` is the EARLIER of the two and it has already passed, the
    // LATER occurrence can still be minutes away — returning null here would
    // make the caller advance a whole day, past an instant that is actually
    // imminent. Detect the shift
    // by comparing the zone's offset now against a day later, when any
    // transition in between has settled: a POSITIVE shift is exactly a
    // fall-back (the offset got smaller); anything else — no transition, or
    // a spring-forward, where the offset grows — leaves nothing to check.
    if (candidate.getTime() < nowFlooredToMinute) {
      const offsetADayLater = offsetMs(
        new Date(now.getTime() + 24 * 60 * 60 * 1000),
        timeZone,
      );
      if (offsetADayLater !== null) {
        const shiftMs = first - offsetADayLater;
        if (shiftMs > 0) {
          const later = new Date(candidate.getTime() + shiftMs);
          if (roundTrips(later)) return later;
        }
      }
    }
    return candidate;
  };

  const today = resolve(0);
  if (today !== null && today.getTime() >= nowFlooredToMinute) return today;
  return resolve(1);
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
  now: Date,
): { at: Date; zone: string } | null {
  // The zone's `/`-joined tail is OPTIONAL (`*`, not `+`): `UTC` and `GMT` are
  // valid, single-component `Intl.DateTimeFormat` zones with no slash at all,
  // and requiring one meant a genuinely resolvable zone still parsed as "no
  // reset clause found," falling through to QUOTA_PARKED instead of the
  // sleep-and-resume it should have gotten. Each segment also needs DIGITS, not
  // just letters: a letters-only class truncates a real zone that happens to
  // contain one — `EST5EDT` (a genuine, DST-observing IANA backward-compat
  // name) matched only as far as `EST` and resolved against the WRONG,
  // fixed-offset zone of that same name, an hour off during daylight time;
  // `Etc/GMT+5` truncated to the invalid `Etc/GMT+` and fell through to
  // QUOTA_PARKED instead of sleeping through a perfectly resolvable wall.
  const m = RESET_CLAUSE_RE.exec(text);
  if (m === null) return null;
  const rawHour = Number.parseInt(m[1] as string, 10);
  const minute = m[2] === undefined ? 0 : Number.parseInt(m[2], 10);
  const meridiem = m[3]?.toLowerCase();
  // Group 4 matched a parenthesized zone, group 5 a bare one — whichever
  // branch of RESET_CLAUSE_RE's alternation matched leaves the other `undefined`.
  const zone = (m[4] ?? m[5]) as string;

  let hour = rawHour;
  if (meridiem === "am") {
    if (rawHour < 1 || rawHour > 12) return null;
    hour = rawHour === 12 ? 0 : rawHour;
  } else if (meridiem === "pm") {
    if (rawHour < 1 || rawHour > 12) return null;
    hour = rawHour === 12 ? 12 : rawHour + 12;
  } else if (rawHour > 23) {
    // A 24-hour spelling is accepted, an out-of-range one is not.
    return null;
  }

  const at = nextWallClock(now, hour, minute, zone);
  return at === null ? null : { at, zone };
}
