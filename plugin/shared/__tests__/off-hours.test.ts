/**
 * The off-hours schedule parser and its windows, read in local time: each
 * instant below is built with the local-time `Date` constructor, so the
 * wall-clock time it states holds in whatever time zone the suite runs in.
 * 2026-10-26 is a Monday.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OFF_HOURS_SCHEDULE,
  OffHoursScheduleError,
  parseSchedule,
  parseWindow,
  windowAt,
} from "../off-hours.ts";

/** A local instant in the week of 2026-10-25 (Sun) to 2026-10-31 (Sat). */
function local(
  day: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat",
  time: string,
): Date {
  const offset = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
  const [h, m] = time.split(":").map(Number);
  return new Date(2026, 9, 25 + offset, h, m);
}

function inside(schedule: readonly string[], when: Date): string | null {
  return windowAt(parseSchedule(schedule), when)?.text ?? null;
}

describe("a window that crosses midnight", () => {
  const nights = ["Mon-Fri 20:00-07:00"];

  test("is open from its start on the day it opens to its end the next morning", () => {
    expect(inside(nights, local("Mon", "20:00"))).toBe("Mon-Fri 20:00-07:00");
    expect(inside(nights, local("Mon", "23:59"))).toBe("Mon-Fri 20:00-07:00");
    expect(inside(nights, local("Tue", "00:00"))).toBe("Mon-Fri 20:00-07:00");
    expect(inside(nights, local("Tue", "06:59"))).toBe("Mon-Fri 20:00-07:00");
    // Friday's night runs into Saturday.
    expect(inside(nights, local("Sat", "03:00"))).toBe("Mon-Fri 20:00-07:00");
  });

  test("is closed at its end, before its start, and on a day it does not open", () => {
    expect(inside(nights, local("Tue", "07:00"))).toBeNull();
    expect(inside(nights, local("Mon", "19:59"))).toBeNull();
    // Monday's early hours belong to Sunday's night, which this window does not open on.
    expect(inside(nights, local("Mon", "03:00"))).toBeNull();
    expect(inside(nights, local("Sat", "20:00"))).toBeNull();
  });
});

describe("a weekend-only window", () => {
  test("covers each of its days whole and nothing else", () => {
    const weekend = ["Sat-Sun"];
    expect(inside(weekend, local("Sat", "00:00"))).toBe("Sat-Sun");
    expect(inside(weekend, local("Sun", "23:59"))).toBe("Sat-Sun");
    expect(inside(weekend, local("Fri", "23:59"))).toBeNull();
    expect(inside(weekend, local("Mon", "00:00"))).toBeNull();
  });
});

describe("a window spanning the week boundary", () => {
  test("a day range past Saturday wraps to Sunday", () => {
    const w = parseWindow("Fri-Mon");
    expect([...w.days].sort()).toEqual([0, 1, 5, 6]);
    expect(inside(["Fri-Mon"], local("Sun", "12:00"))).toBe("Fri-Mon");
    expect(inside(["Fri-Mon"], local("Tue", "12:00"))).toBeNull();
  });

  test("Sunday's night closes on Monday morning", () => {
    expect(inside(["Sun 22:00-02:00"], local("Mon", "01:00"))).toBe(
      "Sun 22:00-02:00",
    );
    expect(inside(["Sun 22:00-02:00"], local("Mon", "02:00"))).toBeNull();
    expect(inside(["Sat 22:00-02:00"], local("Sun", "01:30"))).toBe(
      "Sat 22:00-02:00",
    );
  });
});

describe("the default schedule", () => {
  test("is weekday nights and the weekend", () => {
    expect(inside(DEFAULT_OFF_HOURS_SCHEDULE, local("Wed", "21:00"))).toBe(
      "Mon-Fri 20:00-07:00",
    );
    expect(inside(DEFAULT_OFF_HOURS_SCHEDULE, local("Sun", "12:00"))).toBe(
      "Sat-Sun",
    );
    expect(
      inside(DEFAULT_OFF_HOURS_SCHEDULE, local("Wed", "12:00")),
    ).toBeNull();
  });
});

describe("the grammar", () => {
  test("times alone open every day; comma lists and letter case are read", () => {
    expect(parseWindow("22:00-06:00").days.size).toBe(7);
    expect([...parseWindow("mon,WED,Fri-Sat").days].sort()).toEqual([
      1, 3, 5, 6,
    ]);
    expect(parseWindow("Mon 09:00-17:30").length).toBe(8 * 60 + 30);
  });

  test("an unreadable window names what is wrong", () => {
    for (const bad of [
      "",
      "Someday",
      "Mon 25:00-07:00",
      "Mon 20:00",
      "Mon Tue 20:00-07:00",
      "Mon-Tue-Wed",
    ])
      expect(() => parseWindow(bad)).toThrow(OffHoursScheduleError);
  });
});
