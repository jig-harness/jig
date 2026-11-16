import { expect, test } from "bun:test";
import { deferralTrackerConfig } from "../scripts/lib/deferral-config.ts";
import { configuredTracker } from "../scripts/file-deferred.ts";

test("the PR-body fallback opens the same deferral team as the direct command", () => {
  const values = {
    issue_tracker: { adapter: "linear", team: "BASE" },
    review: { deferral_team: "REVIEW" },
  };
  const fallback = configuredTracker(values);
  expect(fallback.why).toBeUndefined();
  expect(fallback.tracker?.team).toBe("REVIEW");
  expect(fallback.tracker?.team).toBe(
    deferralTrackerConfig(values, values.review).team ?? undefined,
  );
});

test("a Linear command override wins over both configured team defaults", () => {
  const config = deferralTrackerConfig(
    { issue_tracker: { adapter: "linear", team: "BASE" } },
    { deferral_team: "REVIEW" },
    "REQUESTED",
  );
  expect(config.adapter).toBe("linear");
  expect(config.team).toBe("REQUESTED");
});

test("the review deferral team supplies Linear's team before required configuration is parsed", () => {
  expect(
    deferralTrackerConfig(
      { issue_tracker: { adapter: "linear" } },
      { deferral_team: "REVIEW" },
    ).team,
  ).toBe("REVIEW");
  expect(
    deferralTrackerConfig(
      { issue_tracker: { adapter: "linear", team: "BASE" } },
      {},
    ).team,
  ).toBe("BASE");
});

test("an explicit team override is refused for other adapters while a legacy review default is harmless", () => {
  expect(() =>
    deferralTrackerConfig(
      { issue_tracker: { adapter: "github" } },
      {},
      "REQUESTED",
    ),
  ).toThrow("only applies to Linear");
  expect(
    deferralTrackerConfig(
      { issue_tracker: { adapter: "github" } },
      { deferral_team: "LEGACY" },
    ).adapter,
  ).toBe("github");
});
