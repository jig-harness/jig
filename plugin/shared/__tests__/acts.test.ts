/**
 * The closed list of acts a need opens with, and the tables that give each
 * need its act: by the park's registry class, by the cause, and Decide for
 * whatever no table names, so no need is ever hidden.
 */
import { describe, expect, it } from "bun:test";
import { actOfClass, actOfNeed, NEED_ACTS } from "../acts.ts";

describe("actOfClass", () => {
  it("names each registry class's act", () => {
    expect(
      ["scope", "next-item", "reopen-or-waive", "escalated", "human-decision"].map(actOfClass),
    ).toEqual(Array(5).fill("Decide"));
    expect(
      [
        "ready",
        "release",
        "destructive",
        "legal",
        "copy",
        "dark-dial",
        "rules",
        "reviewer-posture",
      ].map(actOfClass),
    ).toEqual(Array(8).fill("Authorize"));
    expect(actOfClass("human-thread")).toBe("Reply");
  });

  it("reads a class of a repository's own, or none, as Decide", () => {
    expect(actOfClass("pricing")).toBe("Decide");
    expect(actOfClass(null)).toBe("Decide");
    expect(actOfClass(undefined)).toBe("Decide");
  });

  it("names an act from the closed list for every class", () => {
    for (const c of ["release", "pricing", "human-thread"])
      expect(NEED_ACTS).toContain(actOfClass(c));
  });
});

describe("actOfNeed", () => {
  it("takes a park's act from its class", () => {
    expect(actOfNeed({ cause: "parked", decisionClass: "release" })).toBe(
      "Authorize",
    );
    expect(actOfNeed({ cause: "parked", decisionClass: null })).toBe("Decide");
  });

  it("names the failures the line could not recover Investigate", () => {
    for (const cause of [
      "stalled",
      "double-claim",
      "needs-person",
      "stopped-unknown",
      "followup-failed",
      "followup-stale",
    ])
      expect(actOfNeed({ cause })).toBe("Investigate");
    expect(
      actOfNeed({ cause: "parked", decisionClass: "release", stuck: true }),
    ).toBe("Investigate");
  });

  it("names a waiting session Reply and a writer's assignment Do", () => {
    expect(actOfNeed({ cause: "nudge-unanswered" })).toBe("Reply");
    expect(actOfNeed({ cause: "assigner-cannot-write" })).toBe("Do");
  });

  it("reads an unknown cause as Decide", () => {
    expect(actOfNeed({ cause: "something-new" })).toBe("Decide");
  });
});
