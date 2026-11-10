/** The claim settings a repository's `do_item` section sets. */
import { describe, expect, it } from "bun:test";
import { claimSettingsOf } from "../scripts/lib/claim-settings.ts";

describe("claimSettingsOf", () => {
  it("keeps today's claim when nothing is set", () => {
    for (const overlay of [null, {}, { do_item: {} }, { do_item: null }])
      expect(claimSettingsOf(overlay)).toEqual({
        claimFrom: null,
        claimMarker: false,
      });
  });

  it("reads claim_from and claim_marker", () => {
    expect(
      claimSettingsOf({
        do_item: { claim_from: ["todo", "backlog"], claim_marker: true },
      }),
    ).toEqual({ claimFrom: ["todo", "backlog"], claimMarker: true });
  });

  it("refuses a claim_from the claim cannot use", () => {
    for (const value of [[], "todo", ["ready"], ["todo", "todo"], ["in_progress"]])
      expect(() => claimSettingsOf({ do_item: { claim_from: value } })).toThrow(
        "do_item.claim_from",
      );
  });

  it("refuses a claim_marker that is not true or false", () => {
    expect(() => claimSettingsOf({ do_item: { claim_marker: "yes" } })).toThrow(
      "do_item.claim_marker",
    );
  });
});
