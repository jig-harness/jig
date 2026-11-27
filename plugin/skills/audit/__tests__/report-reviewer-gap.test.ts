/**
 * The audit sheet for a repository whose pull requests only people review:
 * under the Team/Standard profile, M7's automated-reviewer criteria are gaps
 * to close, never practices the repository's shape rules out.
 */
import { describe, expect, test } from "bun:test";
import { renderReportMarkdown } from "../scripts/report/markdown.ts";
import { mapRows, targetsOf } from "../scripts/report/model.ts";
import { noProfile, recordText, reportInput } from "./report-fixtures.ts";

const input = reportInput({
  record: recordText(["profile: team-standard"]),
  source: noProfile,
});
const m7 = mapRows(input, targetsOf(input)).find(
  (r) => r.module.module === "M7",
);
const cell = (key: string) => m7?.cells.find((c) => c.criterion.key === key);

/** The Standard criteria a missing automated reviewer leaves unmet. */
const REVIEWER = [
  "M7/automated-reviewer-comment-only-with-bar",
  "M7/automated-review-source-independent",
];

describe("a repository with no automated reviewer, against Team/Standard", () => {
  test("the missing reviewer is an M7 gap, not ruled out by the shape", () => {
    expect(
      REVIEWER.map((key) => [key, cell(key)?.score, cell(key)?.gap]),
    ).toEqual(REVIEWER.map((key) => [key, "absent", true]));
    expect(m7?.naReason).toBeFalsy();
  });

  test("the fork-safety lint is a gap while no lint runs, though no workflow uses a privileged trigger", () => {
    const lint = cell("M7/pr-target-wiring-fork-safe");
    expect([lint?.score, lint?.gap]).toEqual(["absent", true]);
  });

  test("the Strict promotion criterion is scored absent too, beyond the target", () => {
    const promotion = cell("M7/reviewer-promotion-gated-on-measurement");
    expect([promotion?.score, promotion?.gap]).toEqual(["absent", false]);
  });

  test("the Markdown copy lists the reviewer as needed for the target", () => {
    const md = renderReportMarkdown(input);
    expect(md).toMatch(
      /\| \*\*automated-reviewer-comment-only-with-bar\*\*: .* \| \*\*absent\*\* \(needed for the target, not met yet[;)]/,
    );
  });
});
