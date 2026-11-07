/** dispatch: a defect can be described whatever value was thrown. */
import { describe, expect, it } from "bun:test";
import { defectOf } from "../lib/defect.ts";

describe("defectOf", () => {
  it("describes a thrown value that has no text form", () => {
    const defect = defectOf("plan", Object.create(null));
    expect(defect).toEqual({
      code: "defect",
      phase: "plan",
      reason:
        "something that is not an error was thrown in the plan phase: an unknown failure",
    });
  });
});
