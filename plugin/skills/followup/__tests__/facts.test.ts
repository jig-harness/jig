import { describe, expect, test } from "bun:test";
import { areasFromPlan } from "../scripts/lib/facts.ts";

describe("change-area plan facts", () => {
  test("refuses a parseable but incomplete plan", () => {
    expect(areasFromPlan("{}", "plan")).toMatchObject({ known: false });
  });

  test("keeps a complete plan", () => {
    expect(
      areasFromPlan(
        JSON.stringify({
          seedAreas: ["plugin"],
          areas: ["plugin"],
          postDeploy: [{ area: "plugin", action: "none" }],
        }),
        "plan",
      ),
    ).toEqual({
      known: true,
      seedAreas: ["plugin"],
      areas: ["plugin"],
      postDeploy: [{ area: "plugin", action: "none" }],
    });
  });
});
