/**
 * `dispatch.followup_routine`: the routine question classes a follow-up may
 * settle unattended. Every class by default; a class the registry does not
 * list is refused by the configuration check; a class left out is no
 * routine class for the follow-ups launched under it.
 */
import { describe, expect, it } from "bun:test";
import {
  offeredClasses,
  offeredField,
  ROUTINE_QUESTIONS,
  routineClassOf,
} from "../lib/routine-questions.ts";
import { dispatchSection } from "../lib/section.ts";

const EVERY = ROUTINE_QUESTIONS.map((q) => q.id);

describe("dispatch.followup_routine", () => {
  it("defaults to every routine class", () => {
    const section = dispatchSection({});
    expect(section.ok && section.value.followupRoutine).toEqual(EVERY);
  });

  it("takes a subset, in the registry's order", () => {
    const section = dispatchSection({
      dispatch: { followup_routine: ["person-owed", "local-leftover"] },
    });
    expect(section.ok && section.value.followupRoutine).toEqual([
      "local-leftover",
      "person-owed",
    ]);
  });

  it("takes an empty list: no class is settled unattended", () => {
    const section = dispatchSection({ dispatch: { followup_routine: [] } });
    expect(section.ok && section.value.followupRoutine).toEqual([]);
  });

  it("refuses a class the registry does not list, naming the setting and the class", () => {
    const section = dispatchSection({
      dispatch: { followup_routine: ["local-leftover", "merge-it"] },
    });
    expect(section.ok).toBe(false);
    if (!section.ok) {
      expect(section.failure.reason).toContain("dispatch.followup_routine");
      expect(section.failure.reason).toContain('"merge-it"');
    }
  });

  it("refuses a value that is not a list, and a class named twice", () => {
    for (const value of ["drafted-items", ["person-owed", "person-owed"]]) {
      const section = dispatchSection({
        dispatch: { followup_routine: value },
      });
      expect(section.ok).toBe(false);
      if (!section.ok)
        expect(section.failure.reason).toContain("dispatch.followup_routine");
    }
  });
});

describe("a follow-up launched with a class left out", () => {
  it("keeps the classes on its record only when one is left out", () => {
    expect(offeredField(EVERY)).toEqual({});
    expect(offeredField(undefined)).toEqual({});
    expect(offeredField(["local-leftover"])).toEqual({
      routineClasses: ["local-leftover"],
    });
  });

  it("reads a question tagged with that class as a person's", () => {
    const offered = offeredClasses({ routineClasses: ["local-leftover"] });
    expect(routineClassOf("[drafted-items] may I file them?", offered)).toBe(
      null,
    );
    expect(routineClassOf("[local-leftover] may I delete it?", offered)).toBe(
      "local-leftover",
    );
    expect(routineClassOf("[drafted-items] may I file them?")).toBe(
      "drafted-items",
    );
  });
});
