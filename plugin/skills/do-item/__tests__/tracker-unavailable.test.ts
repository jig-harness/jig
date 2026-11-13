import { describe, expect, test } from "bun:test";
import { TrackerRateLimited } from "../../../shared/tracker-budget.ts";
import { FacetReadStopped } from "../scripts/lib/tracker/facets/bounds.ts";
import { LinearApiError } from "../scripts/lib/tracker/linear-transport.ts";
import {
  failedHealth,
  isUnavailable,
} from "../scripts/lib/tracker/unavailable.ts";

describe("isUnavailable", () => {
  test.each([
    ["a Linear network failure", new LinearApiError("network", null)],
    ["a Linear server refusal", new LinearApiError("busy", 503)],
    ["a Linear rate limit", new LinearApiError("slow", 429)],
    ["a spent rate limit", new TrackerRateLimited("linear", 1, "spent")],
    ["a stopped facet read", new FacetReadStopped("deadline")],
  ])("reads %s as unanswered", (_name, err) => {
    expect(isUnavailable(err)).toBe(true);
    expect(failedHealth(err)).toMatchObject({ unavailable: true });
  });

  test.each([
    [
      "a Linear answer naming a missing entity",
      new LinearApiError("x", 200, true),
    ],
    ["a Linear query error", new LinearApiError("bad", 200)],
    ["a Linear bad request", new LinearApiError("bad", 400)],
    ["a plain error", new Error("boom")],
  ])("does not read %s as unanswered", (_name, err) => {
    expect(isUnavailable(err)).toBe(false);
  });
});
