/**
 * The drive-pr readers that find issue keys in text, under each tracker's key
 * shape: fleet health's trailer and origin-PR readers, defect escape's
 * follow-up pattern and the branch-name renderer.
 */

import { describe, expect, it } from "bun:test";
import {
  numberKeys,
  teamKeys,
} from "../../do-item/scripts/lib/tracker/keys.ts";
import { followUpPattern } from "../scripts/defect-escape.ts";
import { originPrOf, parseIssueRefs } from "../scripts/lib/fleet-health.ts";
import { renderBranchName } from "../scripts/lib/pr-policy.ts";

const github = numberKeys("owner/name");

describe("parseIssueRefs under a GitHub tracker", () => {
  it("reads #<n> trailers, never another repository's or a marked pull request", () => {
    expect(
      parseIssueRefs("Closes #12, #13 & #14\n\nRefs owner/other#15", github),
    ).toEqual(["#12", "#13", "#14"]);
    expect(parseIssueRefs("Closes PR #16", github)).toEqual([]);
    expect(parseIssueRefs("Closes ENG-1", github)).toEqual([]);
  });

  it("keeps a team's keys to that team, canonicalised", () => {
    expect(parseIssueRefs("closes eng-3, #4", teamKeys("ENG"))).toEqual([
      "ENG-3",
    ]);
  });
});

describe("originPrOf: issues and pull requests share GitHub's number space", () => {
  const issue = (description: string) => ({ title: "x", description });

  it("reads owner/name#<n> as a pull request only when the keys are not those numbers", () => {
    const text = issue("Deferred from owner/name#814 round 2.");
    expect(originPrOf(text, teamKeys("ENG"))).toBe(814);
    expect(originPrOf(text)).toBe(814);
    expect(originPrOf(text, github)).toBeNull();
  });

  it("reads a number a word marks as a pull request under either shape", () => {
    for (const keys of [github, teamKeys("ENG")]) {
      expect(originPrOf(issue("Raised on PR owner/name#815."), keys)).toBe(815);
      expect(originPrOf(issue("see pull request #816"), keys)).toBe(816);
      expect(
        originPrOf(issue("https://github.com/owner/name/pull/817"), keys),
      ).toBe(817);
      expect(
        originPrOf({ title: "PR #818 follow-ups", description: "" }, keys),
      ).toBe(818);
    }
  });
});

describe("followUpPattern", () => {
  it("finds the configured shape's keys", () => {
    const reply = "Deferred to #45 and ENG-7; see owner/other#9";
    expect(reply.match(followUpPattern(github))).toEqual(["#45"]);
    expect(reply.match(followUpPattern(teamKeys("ENG")))).toEqual(["ENG-7"]);
    expect(reply.match(followUpPattern(null))).toEqual(["#45", "ENG-7"]);
  });
});

describe("renderBranchName", () => {
  it("renders the branch segment a GitHub key gives", () => {
    expect(
      renderBranchName("{key_lower}-{slug}", github.toBranch("#12"), "Fix it"),
    ).toBe("12-fix-it");
  });
});
