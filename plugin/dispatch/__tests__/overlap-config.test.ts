/**
 * dispatch.overlap: the overlap settings, read with the rest of the dispatch
 * section from the default branch, each with its default, and a value or a
 * key the section does not know refused with its name.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_OVERLAP,
  overlapOf,
  parseOverlap,
  patienceKey,
} from "../lib/overlap-config.ts";
import { dispatchSection } from "../lib/section.ts";

const HOUR = 3_600_000;

const refusal = (overlap: unknown) => {
  const section = dispatchSection({ dispatch: { overlap } });
  return section.ok ? null : section.failure.reason;
};

describe("dispatch.overlap", () => {
  it("defaults every key", () => {
    const section = dispatchSection({});
    expect(section.ok && section.value.overlap).toEqual(DEFAULT_OVERLAP);
    expect(DEFAULT_OVERLAP).toMatchObject({
      maxPerFile: 4,
      fileRate: 0.5,
      areaRate: 0.2,
      unknownCost: 0.5,
      ignore: [],
      quietAfterMs: 14 * 24 * HOUR,
      boundPatienceMs: 24 * HOUR,
      patienceMs: {
        urgent: 0,
        high: 30 * 60_000,
        medium: 2 * HOUR,
        low: 6 * HOUR,
        none: 6 * HOUR,
      },
    });
    expect(overlapOf({})).toBe(DEFAULT_OVERLAP);
  });

  it("reads every key", () => {
    const read = parseOverlap({
      max_per_file: 0,
      patience: { urgent: "0s", high: "1h", none: 0 },
      file_rate: 0.3,
      area_rate: 0,
      unknown_cost: 2,
      ignore: ["CHANGELOG.md", "docs/**"],
      quiet_after: "48h",
      bound_patience: "12h",
    });
    expect(read.ok && read.value).toEqual({
      maxPerFile: 0,
      patienceMs: {
        urgent: 0,
        high: HOUR,
        medium: 2 * HOUR,
        low: 6 * HOUR,
        none: 0,
      },
      fileRate: 0.3,
      areaRate: 0,
      unknownCost: 2,
      ignore: ["CHANGELOG.md", "docs/**"],
      quietAfterMs: 48 * HOUR,
      boundPatienceMs: 12 * HOUR,
    });
  });

  it("refuses an unknown key, here and in patience, as the section does", () => {
    expect(refusal({ width: 2 })).toStartWith(
      "dispatch.overlap has unknown key(s): width",
    );
    expect(refusal({ patience: { critical: "1h" } })).toStartWith(
      "dispatch.overlap.patience has unknown key(s): critical",
    );
    const section = dispatchSection({ dispatch: { overlaps: {} } });
    expect(section.ok ? null : section.failure.reason).toStartWith(
      "dispatch has unknown key(s): overlaps",
    );
  });

  it("refuses a value of the wrong shape, naming the key", () => {
    expect(refusal("on")).toBe("dispatch.overlap must be a mapping");
    for (const v of [-1, 1.5, "4"])
      expect(refusal({ max_per_file: v })).toStartWith(
        "dispatch.overlap.max_per_file must be a whole number",
      );
    for (const v of [-0.1, 1.1, "0.5"]) {
      expect(refusal({ file_rate: v })).toBe(
        "dispatch.overlap.file_rate must be a number from 0 to 1",
      );
      expect(refusal({ area_rate: v })).toBe(
        "dispatch.overlap.area_rate must be a number from 0 to 1",
      );
    }
    expect(refusal({ unknown_cost: -1 })).toBe(
      "dispatch.overlap.unknown_cost must be a number from 0 to 100",
    );
    expect(refusal({ ignore: "docs/**" })).toBe(
      "dispatch.overlap.ignore must be a list of path globs",
    );
    expect(refusal({ ignore: ["src/{a"] })).toStartWith(
      "dispatch.overlap.ignore: src/{a is not a glob",
    );
    expect(refusal({ quiet_after: "0s" })).toStartWith(
      "dispatch.overlap.quiet_after must be a positive duration",
    );
    expect(refusal({ bound_patience: "2d" })).toStartWith(
      "dispatch.overlap.bound_patience must be a positive duration",
    );
    expect(refusal({ patience: { high: "soon" } })).toStartWith(
      "dispatch.overlap.patience.high must be a positive duration",
    );
    expect(refusal({ patience: "1h" })).toStartWith(
      "dispatch.overlap.patience must be a mapping",
    );
  });

  it("names a tracker priority's patience: 1 urgent to 4 low, anything else none", () => {
    expect([1, 2, 3, 4, 0, undefined, 9].map(patienceKey)).toEqual([
      "urgent",
      "high",
      "medium",
      "low",
      "none",
      "none",
      "none",
    ]);
  });
});
