/** The audit's warning when the claim's start states and the dispatcher's differ. */
import { describe, expect, it } from "bun:test";
import {
  claimFromFindings,
  poolClaimFindings,
} from "../scripts/lib/claim-fit.ts";

describe("claimFromFindings", () => {
  it("says nothing unless both lists are set", () => {
    expect(claimFromFindings({})).toEqual([]);
    expect(claimFromFindings({ do_item: { claim_from: ["todo"] } })).toEqual(
      [],
    );
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

describe("poolClaimFindings", () => {
  it("says nothing unless both lists are set, or when the claim allows every pool state", () => {
    expect(
      poolClaimFindings({ dispatch: { pool: { states: ["todo"] } } }),
    ).toEqual([]);
    expect(
      poolClaimFindings({
        do_item: { claim_from: ["todo", "backlog"] },
        dispatch: { pool: { states: ["todo"] } },
      }),
    ).toEqual([]);
  });

  it("warns, naming each pool state the claim refuses", () => {
    expect(
      poolClaimFindings({
        do_item: { claim_from: ["todo"] },
        dispatch: { pool: { states: ["todo", "backlog"] } },
      }),
    ).toEqual([
      {
        id: "rule:dispatch.pool.states",
        severity: "warning",
        message:
          "dispatch.pool.states names backlog, which do_item.claim_from refuses, so every pickup from there is launched only to be refused",
      },
    ]);
  });
});
