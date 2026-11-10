/** The audit's warning when the claim's start states and the dispatcher's differ. */
import { describe, expect, it } from "bun:test";
import { claimFromFindings } from "../scripts/lib/claim-fit.ts";

describe("claimFromFindings", () => {
  it("says nothing unless both lists are set", () => {
    expect(claimFromFindings({})).toEqual([]);
    expect(claimFromFindings({ do_item: { claim_from: ["todo"] } })).toEqual([]);
    expect(claimFromFindings({ dispatch: { states: ["todo"] } })).toEqual([]);
  });

  it("says nothing when they name the same states", () => {
    expect(
      claimFromFindings({
        do_item: { claim_from: ["todo", "backlog"] },
        dispatch: { states: ["backlog", "todo"] },
      }),
    ).toEqual([]);
  });

  it("warns, naming each difference, when they differ", () => {
    const [finding, ...rest] = claimFromFindings({
      do_item: { claim_from: ["todo", "in_review"] },
      dispatch: { states: ["todo", "backlog"] },
    });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      id: "rule:do_item.claim_from",
      severity: "warning",
    });
    expect(finding?.message).toContain("picks up from backlog");
    expect(finding?.message).toContain("allows in_review");
  });
});
