/**
 * The audit under each tracker's key shape: whether config-fit can probe the
 * tracker, and the team suggestion a GitHub tracker never gets.
 */
import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../../do-item/scripts/lib/tracker/config.ts";
import { trackerTeamSuggestion } from "../scripts/lib/forge-suggestions.ts";
import { trackerProbeable } from "../scripts/lib/tracker-probe.ts";

describe("trackerProbeable", () => {
  it("probes every tracker but a Linear one with no team", () => {
    const probe = (section: Record<string, unknown>) =>
      trackerProbeable(parseTrackerConfig({ issue_tracker: section }));
    expect(probe({ adapter: "linear", team: "ENG" })).toBe(true);
    expect(probe({ adapter: "github" })).toBe(true);
    expect(probe({ adapter: "linear" })).toBe(false);
  });
});

describe("trackerTeamSuggestion", () => {
  const sources = [
    { label: "the last 3 merged pull requests", keys: ["ENG", "ENG", "ENG"] },
  ];

  it("offers the team a Linear tracker's history names", () => {
    expect(
      trackerTeamSuggestion({ issue_tracker: { adapter: "linear" } }, sources),
    ).toMatchObject([{ field: "issue_tracker.team", value: "ENG" }]);
  });

  it("offers the Linear adapter with the team while the adapter is unset", () => {
    expect(trackerTeamSuggestion({}, sources)).toMatchObject([
      { field: "issue_tracker.adapter", value: "linear" },
      { field: "issue_tracker.team", value: "ENG" },
    ]);
  });

  it("offers no team to a GitHub tracker", () => {
    expect(
      trackerTeamSuggestion({ issue_tracker: { adapter: "github" } }, sources),
    ).toEqual([]);
  });
});
