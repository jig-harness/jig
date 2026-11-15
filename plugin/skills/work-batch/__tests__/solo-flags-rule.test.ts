/**
 * `work_batch.solo_flags` as a rule over the item's labels: which label
 * holds an issue back from a batch, pinned so the rule keeps its meaning
 * (any one listed label is enough; the derived flags and the human-in-the-loop
 * label's facets join the list).
 */
import { describe, expect, it } from "bun:test";
import { soloFlagOf } from "../scripts/lib/eligibility.ts";
import { policy } from "./helpers.ts";

const solo = (labels: string[]) =>
  soloFlagOf(
    labels,
    policy({ work_batch: { solo_flags: ["privacy-review"] } }),
  );

describe("work_batch.solo_flags", () => {
  it("holds back an issue carrying any one listed flag", () => {
    expect(solo(["bug", "privacy-review"])).toBe("privacy-review");
  });

  it("joins the derived flags: the catalog's and the fixed ones", () => {
    expect(solo(["db-migration"])).toBe("db-migration");
    expect(solo(["manual-ops"])).toBe("manual-ops");
    expect(solo(["hitl:security"])).toBe("hitl:security");
  });

  it("holds back nothing for labels the list does not name", () => {
    expect(solo(["bug", "privacy"])).toBeNull();
  });

  it("compares a label exactly, case included", () => {
    expect(solo(["Privacy-Review"])).toBeNull();
  });
});
