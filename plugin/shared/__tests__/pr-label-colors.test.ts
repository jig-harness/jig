/**
 * The colors of the pull request state labels (`shared/pr-labels/projection.ts`):
 * a state that signals a problem stands out in a color of the alert family
 * that no other label of the set shares, and green belongs to `converged`
 * alone, so a person scanning a repository's pull requests tells a pull
 * request ready to merge from one that needs them, and one problem from
 * another.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LABELS,
  labelSet,
  PROJECTED_STATES,
  STATE_LABELS,
} from "../pr-labels/projection.ts";

const SET = labelSet({ ...DEFAULT_LABELS, enabled: true });
const colorOf = (name: string): string => {
  const spec = SET.find((l) => l.name === `${DEFAULT_LABELS.prefix}${name}`);
  if (spec === undefined) throw new Error(`${name} is not in the set`);
  return spec.color;
};

/** The hue of a six-digit hex color, in degrees from 0 to 360. */
function hue(color: string): number {
  const [r, g, b] = [0, 2, 4].map(
    (i) => Number.parseInt(color.slice(i, i + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return 0;
  const h =
    max === r
      ? ((g - b) / span) % 6
      : max === g
        ? (b - r) / span + 2
        : (r - g) / span + 4;
  return (h * 60 + 360) % 360;
}

/** Saturation of a six-digit hex color, from 0 to 1 (HSL). */
function saturation(color: string): number {
  const [r, g, b] = [0, 2, 4].map(
    (i) => Number.parseInt(color.slice(i, i + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
}

/** Red through orange: a hue from crimson round to orange, strongly colored. */
const alert = (color: string) =>
  saturation(color) > 0.4 && (hue(color) >= 320 || hue(color) <= 40);
/** Green: a hue between yellow-green and cyan-green, strongly colored. */
const green = (color: string) =>
  saturation(color) > 0.4 && hue(color) >= 80 && hue(color) <= 160;

const problems = PROJECTED_STATES.filter((s) => STATE_LABELS[s].problem);
const problemColors = new Set(problems.map(colorOf));

describe("the state labels' colors", () => {
  it("give converged, parked and followup-failed their own colors", () => {
    expect(colorOf("converged")).toBe("0e8a16");
    expect(colorOf("parked")).toBe("d93f0b");
    expect(colorOf("followup-failed")).toBe("a40e4c");
  });

  it("count parked and followup-failed among the states that signal a problem", () => {
    expect(problems).toContain("parked");
    expect(problems).toContain("followup-failed");
    expect(problems).not.toContain("converged");
  });

  it("give each state that signals a problem a color of the alert family", () => {
    expect(problems.filter((s) => !alert(colorOf(s)))).toEqual([]);
  });

  it("give no two states that signal a problem the same color", () => {
    expect(problemColors.size).toBe(problems.length);
  });

  it("give no other label of the set a problem state's color, nor any of the alert family", () => {
    const names = new Set(problems.map((s) => `${DEFAULT_LABELS.prefix}${s}`));
    const others = SET.filter((l) => !names.has(l.name));
    expect(
      others.filter((l) => problemColors.has(l.color)).map((l) => l.name),
    ).toEqual([]);
    expect(others.filter((l) => alert(l.color)).map((l) => l.name)).toEqual([]);
  });

  it("keep green for converged alone", () => {
    expect(SET.filter((l) => green(l.color)).map((l) => l.name)).toEqual([
      `${DEFAULT_LABELS.prefix}converged`,
    ]);
  });
});
