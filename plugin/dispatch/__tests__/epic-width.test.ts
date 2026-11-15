/**
 * dispatch.epic_width: how many children of an epic with no execution plan
 * are under way at once, read from the default branch's dispatch section.
 */
import { describe, expect, it } from "bun:test";
import { dispatchSection } from "../lib/section.ts";

describe("dispatch.epic_width", () => {
  it("defaults to 4", () => {
    const section = dispatchSection({});
    expect(section.ok && section.value.epicWidth).toBe(4);
  });

  it("takes a positive whole number, 1 included", () => {
    for (const width of [1, 2, 12]) {
      const section = dispatchSection({ dispatch: { epic_width: width } });
      expect(section.ok && section.value.epicWidth).toBe(width);
    }
  });

  it("refuses a width that is not a positive whole number", () => {
    for (const width of [0, -1, 1.5, "4", true]) {
      const section = dispatchSection({ dispatch: { epic_width: width } });
      expect(section.ok ? null : section.failure.reason).toBe(
        "dispatch.epic_width must be a positive whole number",
      );
    }
  });
});
