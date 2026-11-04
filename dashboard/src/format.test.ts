import { describe, expect, it } from "bun:test";
import {
  ago,
  clock,
  hostDay,
  inputOf,
  instantOf,
  lengthOf,
  plural,
  serverNow,
  span,
  stamp,
  until,
} from "./format.ts";

const AT = Date.UTC(2026, 10, 3, 16, 45, 30);

describe("spans", () => {
  it("says minutes, then hours and minutes, then days", () => {
    expect(span(0)).toBe("0 min");
    expect(span(47)).toBe("47 min");
    expect(span(60)).toBe("1 h");
    expect(span(77)).toBe("1 h 17 min");
    expect(span(47 * 60 + 59)).toBe("47 h 59 min");
    expect(span(48 * 60)).toBe("2 d");
  });

  it("counts an age in minutes that have fully passed, never below zero", () => {
    expect(ago(AT - 150_000, AT)).toBe("2 min");
    expect(ago(AT + 150_000, AT)).toBe("0 min");
  });

  it("counts what is still to wait up to the next minute", () => {
    expect(until(AT + 150_000, AT)).toBe("3 min");
    expect(until(AT + 120_000, AT)).toBe("2 min");
  });

  it("states a length", () => {
    expect(lengthOf(74 * 60_000)).toBe("1 h 14 min");
  });

  it("names one and many", () => {
    expect(plural(1, "session")).toBe("1 session");
    expect(plural(3, "session")).toBe("3 sessions");
    expect(plural(2, "repository", "repositories")).toBe("2 repositories");
  });
});

describe("clocks", () => {
  it("shows a time in the zone it is given, not the device's", () => {
    expect(clock(AT, "UTC")).toBe("16:45");
    expect(clock(AT, "Asia/Tokyo")).toBe("01:45");
    expect(clock(AT, "America/New_York")).toBe("11:45");
  });

  it("writes midnight as 00:00", () => {
    expect(clock(Date.UTC(2026, 10, 3, 0, 5), "UTC")).toBe("00:05");
  });

  it("drops the day from a time today and names it otherwise", () => {
    const today = hostDay(AT, "UTC");
    expect(stamp(AT, today, "UTC")).toBe("16:45");
    expect(stamp(Date.UTC(2026, 9, 4, 16, 47), today, "UTC")).toBe(
      "Oct 4 16:47",
    );
  });

  it("decides today in the host's zone", () => {
    const late = Date.UTC(2026, 10, 3, 20, 0);
    const tokyoToday = hostDay(late, "Asia/Tokyo");
    expect(tokyoToday).toBe("2026-11-04");
    expect(stamp(late, tokyoToday, "Asia/Tokyo")).toBe("05:00");
  });
});

describe("a typed time and its instant", () => {
  it("reads a typed time on the zone's clock", () => {
    expect(instantOf("2026-07-01T12:00", "UTC")).toBe(
      "2026-07-01T12:00:00.000Z",
    );
    expect(instantOf("2026-07-01T12:00", "America/New_York")).toBe(
      "2026-07-01T16:00:00.000Z",
    );
    expect(instantOf("2026-01-15T12:00", "America/New_York")).toBe(
      "2026-01-15T17:00:00.000Z",
    );
    expect(instantOf("2026-07-01T12:00", "Asia/Kolkata")).toBe(
      "2026-07-01T06:30:00.000Z",
    );
  });

  it("lands on the right side of a clock change", () => {
    // New York moves its clock forward at 02:00 on this day.
    expect(instantOf("2026-03-08T01:30", "America/New_York")).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(instantOf("2026-03-08T03:30", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    // And back at 02:00 on this one.
    expect(instantOf("2026-11-01T00:30", "America/New_York")).toBe(
      "2026-11-01T04:30:00.000Z",
    );
    expect(instantOf("2026-11-01T03:30", "America/New_York")).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });

  it("shows back the time that was typed", () => {
    for (const zone of [
      "UTC",
      "Asia/Tokyo",
      "Europe/Amsterdam",
      "Asia/Kolkata",
    ])
      for (const typed of ["2026-11-03T04:00", "2026-07-01T23:59"]) {
        const instant = instantOf(typed, zone);
        expect(inputOf(Date.parse(instant ?? ""), zone)).toBe(typed);
      }
  });

  it("gives nothing for text not in that form", () => {
    expect(instantOf("yesterday", "UTC")).toBeNull();
    expect(instantOf("2026-11-03T04:00:00.000Z", "UTC")).toBeNull();
  });
});

describe("the server's clock", () => {
  it("is what it said plus the time since, whatever the device's wall clock reads", () => {
    const said = "2026-11-03T16:47:30.000Z";
    expect(serverNow(said, 1000, 61_000)).toBe(Date.parse(said) + 60_000);
  });

  it("never runs before what it said", () => {
    const said = "2026-11-03T16:47:30.000Z";
    expect(serverNow(said, 5000, 1000)).toBe(Date.parse(said));
  });
});
