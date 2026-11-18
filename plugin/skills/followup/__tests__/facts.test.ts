import { describe, expect, test } from "bun:test";
import { areasFromPlan, itemOf } from "../scripts/lib/facts.ts";

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

describe("the items a merge closes", () => {
  const values = { issue_tracker: { adapter: "github" } };

  test("a batch keeps every closing key, in order and once each", () => {
    const read = itemOf(values, "Closes #12\nCloses #15\nCloses #12", "batch");
    expect(read.items.map((i) => i.key)).toEqual(["#12", "#15"]);
    expect(read.item).toEqual(read.items[0] ?? null);
  });
});
