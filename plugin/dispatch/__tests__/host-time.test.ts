/**
 * "Today" on the host's clock, wherever the server runs, on either side of a
 * clock change.
 */
import { describe, expect, it } from "bun:test";
import { midnightIn } from "../lib/host-time.ts";

const at = (iso: string) => Date.parse(iso);

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
});
