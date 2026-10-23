/**
 * The audit under each tracker's key shape: the issue config-fit asks the
 * tracker for, and the team suggestion a GitHub tracker never gets.
 */
import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../../do-item/scripts/lib/tracker/config.ts";
import { trackerTeamSuggestion } from "../scripts/lib/forge-suggestions.ts";
import { trackerProbeKey } from "../scripts/lib/tracker-probe.ts";

describe("trackerProbeKey", () => {
  it("asks for the first issue in the tracker's key shape", () => {
    const probe = (section: Record<string, unknown>) =>
      trackerProbeKey(parseTrackerConfig({ issue_tracker: section }));
    expect(probe({ adapter: "linear", team: "ENG" })).toBe("ENG-1");
    expect(probe({ adapter: "github" })).toBe("#1");
    expect(probe({ adapter: "linear" })).toBeNull();
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
