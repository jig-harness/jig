/**
 * get_issue.ts reads a key as a person gives it, through the configured
 * tracker's key shape, and its not-found hints name that shape.
 */

import { describe, expect, it } from "bun:test";
import { getIssue } from "../scripts/get_issue.ts";
import { numberKeys, teamKeys } from "../scripts/lib/tracker/keys.ts";
import type { Tracker } from "../scripts/lib/tracker/port.ts";

/** A tracker that has no issue and records the keys it was asked for. */
function emptyTracker(asked: string[]): Tracker {
  return {
    getIssue: async (key: string) => {
      asked.push(key);
      return null;
    },
    stateName: (s: string) => s,
  } as unknown as Tracker;
}

describe("getIssue", () => {
  it("asks a GitHub tracker for #<n> however the issue is given", async () => {
    const asked: string[] = [];
    const keys = numberKeys("owner/name");
    for (const input of [
      "12",
      "#12",
      "https://github.com/owner/name/issues/12",
    ])
      await getIssue(input, emptyTracker(asked), keys);
    expect(asked).toEqual(["#12", "#12", "#12"]);
  });

  it("hints at the configured key shape when the issue is not found", async () => {
    const github = await getIssue("12", emptyTracker([]), numberKeys(null));
    expect(github.error).toBe("Issue #12 not found");
    expect(String(github.suggestions)).toContain("e.g. #123, 123 or");
    expect(String(github.suggestions)).toContain("issue_tracker.github");

    const linear = await getIssue("eng-7", emptyTracker([]), teamKeys("ENG"));
    expect(linear.error).toBe("Issue ENG-7 not found");
    expect(String(linear.suggestions)).toContain("e.g. ENG-123, not just 123");
  });

  it("passes a key the shape does not read on as given", async () => {
    const asked: string[] = [];
    await getIssue("OPS-7", emptyTracker(asked), teamKeys("ENG"));
    await getIssue("OPS-8", emptyTracker(asked), null);
    expect(asked).toEqual(["OPS-7", "OPS-8"]);
  });
});
