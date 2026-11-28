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
    expect(survey).toContain(
      "the audit time when the audited revision is the current tip",
    );
    expect(survey).toContain("the `--at` option");
    expect(survey).toContain("clean checkout of an older commit");
    expect(survey).toContain("whichever branch they target");
    expect(survey).not.toContain("Ignore PRs");
    expect(survey).not.toContain("targeting any branch, not only");
    expect(survey).toContain("in the 90 days before the observation time");
    expect(survey).toContain(
      "Count only activity timestamped within that 90-day window",
    );
    expect(survey).toContain(
      "Distinguish three states of missing host activity evidence",
    );
    expect(survey).toContain(
      "routine turnover of ephemeral intermediate revisions",
    );
    expect(survey).toContain("materially unretained host history");
    expect(survey).toContain(
      "routine turnover of ephemeral intermediate revisions does not make the census incomplete",
    );
    expect(survey).toContain(
      "that surviving record is sufficient to establish the active reviewers (or `absent` when none appear)",
    );
    expect(survey).toContain(
      "inaccessible governing evidence about a confirmed reviewer",
    );
    expect(survey).toContain(
      "branch-protection and ruleset rules visible only to an administrator",
    );
    expect(survey).toContain("opened by `--examine-all`");
    expect(survey).toContain(
      "preserve and report the independently established observations",
    );
    expect(survey).toContain(
      "leave that criterion unresolved, and stop to report the audit incomplete",
    );
    expect(survey).toContain(
      "unchecked channel, materially unretained host history, or inaccessible reviewer configuration or enforcement",
    );
    expect(survey).toContain(
      "Only where confirmed observations already fix the criterion's exact rung",
    );
    expect(survey).toContain(
      "a confirmed in-scope reviewer is already proven `absent` from readable evidence",
    );
    expect(survey).toContain(
      "never guessing `absent` for a confirmed reviewer whose unreadable settings could satisfy the criterion",
    );
    expect(survey).not.toContain(
      "a confirmed reviewer already fails the criterion",
    );
    expect(survey).not.toContain(
      "for either kind of missing evidence — an unchecked channel or unretained host history",
    );
    const skill = readFileSync(`${root}SKILL.md`, "utf8");
    expect(skill).toContain(
      "materially unretained host history as distinguished from routine turnover of ephemeral intermediate revisions in survey 4",
    );
    expect(skill).toContain(
      "inaccessible configuration, policy source, or host enforcement for a confirmed reviewer",
    );
    expect(skill).toContain(
      "preserve and report the confirmed observations, close any unchecked channel or readable gap yourself",
    );
    expect(skill).toContain(
      "only where confirmed observations already fix the criterion's exact rung",
    );
    expect(skill).toContain(
      "a confirmed in-scope reviewer already proven `absent` from readable evidence",
    );
    expect(skill).toContain(
      "never guessing `absent` when unreadable settings could satisfy the criterion",
    );
    expect(skill).not.toContain(
      "where confirmed observations already settle the score",
    );
    expect(skill).not.toContain(
      "missing host evidence — an unchecked channel or unretained host history",
    );
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
