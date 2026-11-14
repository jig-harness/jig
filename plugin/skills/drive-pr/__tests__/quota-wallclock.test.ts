/**
 * quota-wallclock.test.ts — `parseResetClause`, which turns the wall-clock
 * time a vendor prints ("resets 11:40pm (Europe/Amsterdam)") into the instant
 * a drive may resume (`scripts/lib/quota/wallclock.ts`).
 */

import { describe, expect, it } from "bun:test";
import { parseResetClause } from "../scripts/lib/quota/wallclock.ts";

describe("wall-clock reset parsing", () => {
  // Every spelling here was transcribed from a real transcript; the point of
  // the table is that the vendor is not consistent about any of them.
  const now = Temporal.Instant.from("2026-08-20T21:31:00Z"); // 23:31 Europe/Amsterdam
  it.each([
    ["resets 11:40pm (Europe/Amsterdam)", "2026-08-20T21:40:00.000Z"],
    ["resets 3:20am (Europe/Amsterdam)", "2026-08-21T01:20:00.000Z"],
    ["resets 11:40pm Europe/Amsterdam", "2026-08-20T21:40:00.000Z"],
    ["resets 10pm (Europe/Amsterdam)", "2026-08-21T20:00:00.000Z"],
  ])("resolves %p", (text, expected) => {
    expect(
      parseResetClause(text, now)?.at.toString({ fractionalSecondDigits: 3 }),
    ).toBe(expected);
  });

  it("resolves to a whole second, never the reference instant’s milliseconds", () => {
    const odd = Temporal.Instant.from("2026-08-20T21:31:00.884Z");
    const at = parseResetClause("resets 11:40pm (Europe/Amsterdam)", odd)?.at;
    expect(at && at.epochMilliseconds % 1000).toBe(0);
  });

  it("does NOT advance a full day for a reset seconds into the SAME minute", () => {
    // `now` carries 30 seconds past the announced reset minute, but the reset
    // is announced at second-0 precision — comparing at full instant precision
    // would reject today's candidate as "already past" by those 30 seconds and
    // fabricate a ~24-hour delay instead, contradicting this module's own
    // documented "at or after" contract.
    const now = Temporal.Instant.from("2026-08-20T16:40:30Z"); // 18:40:30 Europe/Amsterdam
    expect(
      parseResetClause("resets 6:40pm (Europe/Amsterdam)", now)?.at.toString({
        fractionalSecondDigits: 3,
      }),
    ).toBe("2026-08-20T16:40:00.000Z");
  });

  it("crosses a DST boundary using the offset AT THE ANSWER, not at now", () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET in Europe/Amsterdam. At 23:30 local
    // on the 24th (UTC+2) a 03:20 reset lands after the switch (UTC+1), so a
    // single-pass offset would be an hour wrong.
    const before = Temporal.Instant.from("2026-10-24T21:30:00Z");
    expect(
      parseResetClause("resets 3:20am (Europe/Amsterdam)", before)?.at.toString(
        { fractionalSecondDigits: 3 },
      ),
    ).toBe("2026-10-25T02:20:00.000Z");
  });

  it("resolves the REPEATED fall-back occurrence rather than jumping a full day", () => {
    // 2026-10-25: Europe/Amsterdam's 02:00-03:00 local window occurs TWICE —
    // once as CEST (00:00-01:00 UTC) and again as CET (01:00-02:00 UTC). At
    // 00:45 UTC the first 02:30 occurrence (00:30 UTC) has already passed,
    // but the second one (01:30 UTC) is only 45 minutes away — jumping to
    // tomorrow instead would blow well past planFor's 6-hour sleep cap.
    const duringFallBack = Temporal.Instant.from("2026-10-25T00:45:00Z");
    expect(
      parseResetClause(
        "resets 2:30am (Europe/Amsterdam)",
        duringFallBack,
      )?.at.toString({ fractionalSecondDigits: 3 }),
    ).toBe("2026-10-25T01:30:00.000Z");
  });

  it("resolves the FIRST fall-back occurrence when `now` is seconds into its SAME minute", () => {
    // The minute-floor fix once applied only to the OUTER "at or after"
    // decision, not to this INNER check deciding whether to seek the later
    // ambiguous occurrence — so a `now` a few seconds past the first
    // occurrence's own minute (00:30:30Z here, 30 seconds after the first 00:30
    // occurrence) was treated as "already passed" at full instant precision,
    // and this substituted the SECOND occurrence (01:30Z) instead of correctly
    // returning the still-valid first one — sleeping roughly an unnecessary
    // extra hour.
    const secondsIntoFirstOccurrence = Temporal.Instant.from(
      "2026-10-25T00:30:30Z",
    );
    expect(
      parseResetClause(
        "resets 2:30am (Europe/Amsterdam)",
        secondsIntoFirstOccurrence,
      )?.at.toString({ fractionalSecondDigits: 3 }),
    ).toBe("2026-10-25T00:30:00.000Z");
  });

  it.each([
    ["resets 11:40pm (UTC)", "2026-08-20T23:40:00.000Z"],
    ["resets 11:40pm (GMT)", "2026-08-20T23:40:00.000Z"],
  ])("resolves a single-component zone %p", (text, expected) => {
    // UTC and GMT are valid Intl.DateTimeFormat zones with no `/` at all —
    // requiring one meant a genuinely resolvable zone parsed as "no reset
    // clause found" and fell through to QUOTA_PARKED instead of sleeping.
    expect(
      parseResetClause(text, now)?.at.toString({ fractionalSecondDigits: 3 }),
    ).toBe(expected);
  });

  it("resolves a zone identifier containing digits", () => {
    // The POSIX sign is inverted: Etc/GMT+5 is UTC-5 without daylight time.
    expect(
      parseResetClause("resets 11:40pm (Etc/GMT+5)", now)?.at.toString({
        fractionalSecondDigits: 3,
      }),
    ).toBe("2026-08-21T04:40:00.000Z");
  });

  it.each([
    "no reset clause at all",
    "resets 99:99am (Europe/Amsterdam)",
    "resets 3:20am (Not/AZone)",
    "resets 13pm (Europe/Amsterdam)",
    // An OPEN paren with no CLOSE, ending the string right after the zone —
    // independently-optional `\(?...\)?` groups accepted this too, and once
    // this pattern is embedded in an ANCHORED, fail-closed matcher (the Claude
    // adapter's session-limit notice), accepting it means classifying a
    // malformed notice as a trusted, sleepable window. The mirror case — a bare
    // zone with a stray trailing `)` and no matching `(` — is NOT a case for
    // this function: `parseResetClause` searches for an EMBEDDED clause and is
    // never anchored to the end of the string, so trailing text after a
    // validly-recognised bare zone is by design not this function's problem;
    // the claude-adapter test below covers it where it actually matters, in the
    // anchored notice matcher.
    "resets 6:40pm (Europe/Amsterdam",
  ])("returns null rather than guessing for %p", (text) => {
    expect(parseResetClause(text, now)).toBeNull();
  });

  it("refuses a wall clock that does not exist on a spring-forward day", () => {
    // 2026-03-29: Europe/Amsterdam jumps 02:00 CET -> 03:00 CEST, so no local
    // instant that day displays 02:30. Without a round-trip check the two-pass
    // offset correction lands on some OTHER instant and reports it as if the
    // requested wall clock were real.
    const springForwardEve = Temporal.Instant.from("2026-03-28T20:00:00Z"); // 21:00 CET
    expect(
      parseResetClause("resets 2:30am (Europe/Amsterdam)", springForwardEve),
    ).toBeNull();
  });
});
