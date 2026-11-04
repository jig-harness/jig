import { describe, expect, it } from "bun:test";
import {
  buildLegend,
  eventRole,
  ROLES,
  roleOf,
  STAGE_LEGEND,
  stageMark,
} from "./status.ts";

describe("a recorded word's role", () => {
  it("follows the set it was recorded in", () => {
    expect(roleOf("outcome class", "stalled")).toBe(ROLES.badly);
    expect(roleOf("notify cause", "stalled")).toBe(ROLES.needs);
    expect(roleOf("outcome class", "parked for a person")).toBe(ROLES.needs);
    expect(roleOf("agent state", "blocked")).toBe(ROLES.waiting);
    expect(roleOf("launch record", "pending")).toBe(ROLES.waiting);
  });

  it("is unknown for a word the mapping does not place", () => {
    expect(roleOf("outcome class", "not a class")).toBe(ROLES.unknown);
    expect(roleOf("outcome class", "constructor")).toBe(ROLES.unknown);
  });

  it("places an observation by its notify cause, else as held back", () => {
    expect(eventRole("drifting")).toBe(ROLES.waiting);
    expect(eventRole("nudge")).toBe(ROLES.held);
    expect(eventRole("toString")).toBe(ROLES.held);
  });
});

describe("the marks", () => {
  it("gives each role its own key cap, so no role is told by colour alone", () => {
    const glyphs = Object.values(ROLES).map((r) => r.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("gives each stage one mark, and none to a stage it does not know", () => {
    expect(stageMark("rearm")).toBe("↻");
    expect(stageMark("hold")).toBe("");
    expect(stageMark("constructor")).toBe("");
    const marks = STAGE_LEGEND.map((s) => s.mark);
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe("the legend", () => {
  it("holds the eight words, in the order the page shows them", () => {
    expect(buildLegend().map((r) => r.word)).toEqual([
      "needs a person",
      "working",
      "waiting",
      "held back",
      "finished well",
      "finished badly",
      "stale",
      "unknown",
    ]);
  });

  it("lists each recorded word under its role, per set", () => {
    const badly = buildLegend().find((r) => r.word === "finished badly");
    expect(badly?.sets.find((s) => s.set === "outcome class")?.items).toBe(
      "gates failed, died, stalled, refused, quota wall, double claim, unknown",
    );
  });

  it("leaves out a set with no word for that role", () => {
    const stale = buildLegend().find((r) => r.word === "stale");
    expect(stale?.sets.map((s) => s.set)).toEqual(["ledger class", "label"]);
  });
});
