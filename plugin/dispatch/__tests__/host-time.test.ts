/**
 * "Today" on the host's clock, wherever the server runs, on either side of a
 * clock change; and the host's date, wall clock and ISO week.
 */
import { describe, expect, it } from "bun:test";
import {
  dateIn,
  isoWeekIn,
  midnightIn,
  wallClockIn,
} from "../lib/host-time.ts";

const at = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;

describe("midnightIn", () => {
  it("is the start of the day in a zone ahead of or behind UTC", () => {
    const now = at("2026-11-03T16:47:30.000Z");
    expect(midnightIn("UTC", now)).toBe(at("2026-11-03T00:00:00.000Z"));
    expect(midnightIn("Asia/Tokyo", now)).toBe(at("2026-11-03T15:00:00.000Z"));
    expect(midnightIn("America/New_York", now)).toBe(
      at("2026-11-03T05:00:00.000Z"),
    );
  });

  it("follows the host's date when the zone's day differs from UTC's", () => {
    // 01:00 UTC is still the evening before in New York.
    expect(midnightIn("America/New_York", at("2026-11-04T01:00:00.000Z"))).toBe(
      at("2026-11-03T05:00:00.000Z"),
    );
  });

  it("steps back a day across a clock change", () => {
    // New York left summer time on 1 November 2026.
    const after = at("2026-11-02T12:00:00.000Z");
    expect(midnightIn("America/New_York", after)).toBe(
      at("2026-11-02T05:00:00.000Z"),
    );
    expect(midnightIn("America/New_York", after, -1)).toBe(
      at("2026-11-01T04:00:00.000Z"),
    );
  });

  it("holds on the day of a clock change itself", () => {
    expect(midnightIn("America/New_York", at("2026-11-01T20:00:00.000Z"))).toBe(
      at("2026-11-01T04:00:00.000Z"),
    );
  });

  it("starts a day whose clock change skips midnight at its first moment", () => {
    // Santiago's clocks went from 00:00 to 01:00 on 6 September 2026.
    expect(midnightIn("America/Santiago", at("2026-09-06T12:00:00.000Z"))).toBe(
      at("2026-09-06T04:00:00.000Z"),
    );
    expect(
      midnightIn("America/Santiago", at("2026-09-06T12:00:00.000Z"), -1),
    ).toBe(at("2026-09-05T04:00:00.000Z"));
  });
});

describe("the host's calendar", () => {
  it("reads the date and the wall clock on the zone's own clock", () => {
    const now = at("2026-11-04T01:30:45.000Z");
    expect(dateIn("UTC", now)).toBe("2026-11-04");
    // Still the evening before in New York.
    expect(dateIn("America/New_York", now)).toBe("2026-11-03");
    expect(wallClockIn("America/New_York", now)).toBe("2026-11-03T20:30");
    expect(wallClockIn("Asia/Tokyo", now)).toBe("2026-11-04T10:30");
  });

  it("names the ISO week, Monday to Sunday, of the zone's date", () => {
    // Sunday 8 November 2026 ends week 45; Monday 9 November starts week 46.
    expect(isoWeekIn("UTC", at("2026-11-08T23:59:59.000Z"))).toBe("2026-W45");
    expect(isoWeekIn("UTC", at("2026-11-09T00:00:00.000Z"))).toBe("2026-W46");
    // 23:30 UTC on Sunday is already Monday in Tokyo.
    expect(isoWeekIn("Asia/Tokyo", at("2026-11-08T23:30:00.000Z"))).toBe(
      "2026-W46",
    );
  });

  it("gives the days around the new year to the week that holds their Thursday", () => {
    // 1 January 2027 is a Friday: it belongs to the last week of 2026.
    expect(isoWeekIn("UTC", at("2027-01-01T12:00:00.000Z"))).toBe("2026-W53");
    expect(isoWeekIn("UTC", at("2027-01-04T12:00:00.000Z"))).toBe("2027-W01");
    // 29 December 2025 is a Monday whose Thursday falls in 2026.
    expect(isoWeekIn("UTC", at("2025-12-29T12:00:00.000Z"))).toBe("2026-W01");
  });
});
