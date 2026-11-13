import { describe, expect, test } from "bun:test";
import {
  isCalendarDate,
  isoFromMs,
  isoOf,
  currentIso,
  currentMs,
  parseHttpDateMs,
  parseInstant,
  parseMs,
} from "../time.ts";

describe("writing", () => {
  test("isoFromMs writes what Date.toISOString wrote, to the millisecond", () => {
    for (const ms of [0, -1, 1794477600123, 951782400000, 253402300799999])
      expect(isoFromMs(ms)).toBe(new Date(ms).toISOString());
  });

  test("a fraction of a millisecond is dropped, as Date dropped it", () => {
    expect(isoFromMs(1.9)).toBe(new Date(1.9).toISOString());
    expect(isoFromMs(-1.5)).toBe(new Date(-1.5).toISOString());
  });

  test("a moment Date cannot write throws, as Date threw", () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1])
      expect(() => isoFromMs(ms)).toThrow(RangeError);
  });

  test("isoOf drops the nanoseconds Temporal would print", () => {
    const instant = Temporal.Instant.from("2026-11-12T10:00:00.123456789Z");
    expect(instant.toString()).toContain("123456789");
    expect(isoOf(instant)).toBe("2026-11-12T10:00:00.123Z");
  });

  test("currentIso and currentMs read the same clock", () => {
    const before = currentMs();
    const iso = currentIso();
    const after = currentMs();
    expect(iso).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(iso)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(iso)).toBeLessThanOrEqual(after);
  });
});

describe("parsing", () => {
  const expected = Date.parse("2026-11-12T10:00:00Z");

  test.each([
    "2026-11-12T10:00:00Z",
    "2026-11-12T10:00:00.000Z",
    "2026-11-12T10:00:00.000000Z",
    "2026-11-12T11:00:00+01:00",
    "2026-11-12T11:00:00+0100",
    "2026-11-12 10:00:00 +0000",
    "2026-11-12 11:00:00 +01:00",
    "2026-11-12T10:00:00",
    "  2026-11-12T10:00:00Z  ",
  ])("reads %p", (text) => {
    expect(parseMs(text)).toBe(expected);
  });

  test("a date alone is midnight UTC, as Date.parse read it", () => {
    expect(parseMs("2026-11-12")).toBe(Date.parse("2026-11-12"));
  });

  test("a string that is not one of these forms is NaN", () => {
    for (const text of [
      "",
      "garbage",
      "Tue, 12 Nov 2026 10:00:00 GMT",
      "2026-13-40",
    ])
      expect(parseMs(text)).toBeNaN();
  });

  test("a wrong offset is not read as UTC", () => {
    expect(parseMs("2026-11-12T10:00:00+99:99")).toBeNaN();
  });

  test("a second-resolution offset or an annotation keeps its offset", () => {
    expect(parseMs("2026-11-12T11:00:00+01:00:30")).toBe(
      Temporal.Instant.from("2026-11-12T09:59:30Z").epochMilliseconds,
    );
    expect(parseMs("2026-11-12T11:00:00+01:00[Europe/Paris]")).toBe(
      Temporal.Instant.from("2026-11-12T10:00:00Z").epochMilliseconds,
    );
    expect(parseMs("2026-11-12T11:00:00[Europe/Paris]")).toBeNaN();
  });

  test("parseInstant throws where parseMs answers NaN", () => {
    expect(() => parseInstant("garbage")).toThrow(RangeError);
    expect(parseInstant("2026-11-12T10:00:00Z").epochMilliseconds).toBe(
      expected,
    );
  });
});

describe("HTTP dates", () => {
  test("reads the form Retry-After carries", () => {
    expect(parseHttpDateMs("Tue, 12 Nov 2026 10:00:00 GMT")).toBe(
      Date.parse("Tue, 12 Nov 2026 10:00:00 GMT"),
    );
  });

  test("anything else is NaN", () => {
    for (const text of [
      "",
      "120",
      "2026-11-12T10:00:00Z",
      "Tue, 32 Nov 2026 10:00:00 GMT",
      "Tue, 12 Xyz 2026 10:00:00 GMT",
    ])
      expect(parseHttpDateMs(text)).toBeNaN();
  });
});

describe("calendar dates", () => {
  test.each(["2026-11-12", "2024-02-29", "0001-01-01", "9999-12-31"])(
    "%s is one",
    (text) => expect(isCalendarDate(text)).toBe(true),
  );

  test.each([
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-1-01",
    "2026-01-01T00:00:00Z",
    " 2026-01-01",
    "",
  ])("%p is not", (text) => expect(isCalendarDate(text)).toBe(false));
});
