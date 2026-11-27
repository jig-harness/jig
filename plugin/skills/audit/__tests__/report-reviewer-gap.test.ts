/**
 * The audit sheet for a repository whose pull requests only people review:
 * under the Team/Standard profile, M7's automated-reviewer criteria are gaps
 * to close, never practices the repository's shape rules out.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { renderReportMarkdown } from "../scripts/report/markdown.ts";
import { mapRows, targetsOf } from "../scripts/report/model.ts";
import { noProfile, recordText, reportInput } from "./report-fixtures.ts";

/** The Standard criteria a missing automated reviewer leaves unmet. */
const REVIEWER = [
  "M7/automated-reviewer-comment-only-with-bar",
  "M7/automated-review-source-independent",
];

const input = reportInput({
  record: recordText(["profile: team-standard"]),
  source: (s) => {
    noProfile(s);
    (s.recommendations as unknown[]).push({
      id: "R9",
      refs: [...REVIEWER],
      title: "Add an automated pull-request reviewer",
      finding: "No automated reviewer reviews pull requests.",
      action: "Install one comment-only and write down its precision bar.",
      evidence: ["no reviewer wiring in .github/workflows"],
      leverage: "high",
      effort: "small",
      quick_win: false,
    });
  },
});
const m7 = mapRows(input, targetsOf(input)).find(
  (r) => r.module.module === "M7",
);
const cell = (key: string) => m7?.cells.find((c) => c.criterion.key === key);

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

  test("a recommendation to add a reviewer covers the gap in the rendered report", () => {
    const md = renderReportMarkdown(input);
    expect(md).toContain("Add an automated pull-request reviewer");
    for (const key of REVIEWER) {
      expect(md).not.toMatch(
        new RegExp(
          `${key.split("/")[1]}\\*\\*: .*a gap no recommendation covers`,
        ),
      );
    }
  });

  test("the Markdown copy lists the reviewer as needed for the target", () => {
    const md = renderReportMarkdown(input);
    expect(md).toMatch(
      /\| \*\*automated-reviewer-comment-only-with-bar\*\*: .* \| \*\*absent\*\* \(needed for the target, not met yet[;)]/,
    );
  });

  test("the scoring guidance behind the scores says a missing reviewer is absent, and a draft leaves unexamined criteria alone", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const survey = readFileSync(
      `${root}references/survey-prompts/04-review-learning-loop.md`,
      "utf8",
    );
    expect(survey).toContain("`absent`, never");
    expect(survey).toContain("When examined");
    expect(survey).toContain("a draft's unexamined criteria stay as they are");
    const criteria = readFileSync(
      `${root}criteria/M7-pr-lifecycle-review.yaml`,
      "utf8",
    );
    expect(criteria).toContain("with none, this is absent");
    expect(criteria).toContain(
      "with none, there is no reviewer whose source is independent: absent",
    );
  });
});
