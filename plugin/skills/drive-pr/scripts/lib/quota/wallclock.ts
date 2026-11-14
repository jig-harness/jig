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
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let here: Temporal.ZonedDateTime;
  try {
    here = now.toZonedDateTimeISO(timeZone);
  } catch (error) {
    // An unknown zone name throws RangeError. That is "cannot resolve", which
    // is this module's null, not an error for a caller mid-diagnosis to catch.
    if (error instanceof RangeError) return null;
    throw error;
  }

  // Every "has this candidate already passed" decision in this function
  // compares against this FLOORED value, never against `now` directly: a
  // candidate is always constructed at second 0 of its target minute, so an
  // instant-precision comparison rejects one seconds into the SAME minute as
  // already past. That holds for the OUTER "at or after" decision below and
  // for the IDENTICAL comparison inside `resolve()` itself, which decides
  // whether to seek a fall-back-transition's LATER occurrence. Left at full
  // precision there, a genuinely valid FIRST occurrence a few seconds into the
  // current minute (during a fall-back's doubled hour) is wrongly treated as
  // passed and swapped for the second, later occurrence instead — sleeping
  // roughly an extra hour.
  const nowFlooredToMinute =
    Math.floor(now.epochMilliseconds / 60_000) * 60_000;

  // Resolve a candidate date (zone-local Y/M/D + the target time) to an
  // instant.
  const resolve = (dayShift: number): Temporal.Instant | null => {
    const wall = here
      .toPlainDate()
      .add({ days: dayShift })
      .toPlainDateTime({ hour, minute });
    const earlier = wall.toZonedDateTime(timeZone, {
      disambiguation: "earlier",
    });

    // On a spring-forward day the requested wall clock may not exist — e.g.
    // Europe/Amsterdam has no 02:30 on its transition date — and the instant
    // Temporal picks then shows some OTHER local time, not the one asked for.
    // Refuse rather than hand the caller a fabricated deadline it could sleep
    // against.
    if (!earlier.toPlainDateTime().equals(wall)) return null;

    // A fall-back transition means one local wall clock occurs TWICE. If the
    // EARLIER of the two has already passed, the LATER occurrence can still be
    // minutes away — returning null here would make the caller advance a whole
    // day, past an instant that is actually imminent.
    if (earlier.epochMilliseconds < nowFlooredToMinute)
      return wall
        .toZonedDateTime(timeZone, { disambiguation: "later" })
        .toInstant();
    return earlier.toInstant();
  };

  const today = resolve(0);
  if (today !== null && today.epochMilliseconds >= nowFlooredToMinute)
    return today;
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
