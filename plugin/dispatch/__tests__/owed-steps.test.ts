/**
 * The out-of-tree section of a pull request's description: which steps it
 * lists still owed and which are done, and the repository's
 * manual-operations label read from its configuration.
 */
import { describe, expect, it } from "bun:test";
import { manualOpsLabel, owedSteps, owesSteps } from "../lib/owed-steps.ts";

const body = (...lines: string[]) => lines.join("\n");

describe("the out-of-tree section", () => {
  it("counts each listed step, a plain item or an unchecked box, as owed", () => {
    expect(
      owedSteps(
        body(
          "## Summary",
          "- not a step: another section's item",
          "",
          "## Out-of-tree follow-ups",
          "",
          "- [ ] Set the `DEPLOY_KEY` secret in the staging environment",
          "- Run the backfill once the merge deploys",
          "1. Announce the change on the status page",
          "",
          "## Test plan",
          "- [ ] not a step either",
        ),
      ),
    ).toEqual({ open: 3, done: 0 });
  });

  it("owes nothing for the explicit None, an empty section or no section", () => {
    expect(
      owesSteps(
        body(
          "## Out-of-tree follow-ups",
          "",
          "_None — merging this PR completes the issue._",
        ),
      ),
    ).toBe(false);
    expect(owesSteps(body("## Out-of-tree follow-ups", "", "- None"))).toBe(
      false,
    );
    expect(owesSteps(body("## Out-of-tree follow-ups", "", "## Next"))).toBe(
      false,
    );
    expect(owesSteps(body("## Summary", "- a change"))).toBe(false);
    expect(owesSteps("")).toBe(false);
  });

  it("counts a checked box as done, and owes nothing once every box is checked", () => {
    const listed = (first: string, second: string) =>
      body(
        "## Out-of-tree follow-ups",
        `- [${first}] Create the \`automation\` label`,
        `- [${second}] Turn the timer on`,
      );
    expect(owedSteps(listed("x", " "))).toEqual({ open: 1, done: 1 });
    expect(owesSteps(listed("x", " "))).toBe(true);
    expect(owedSteps(listed("x", "X"))).toEqual({ open: 0, done: 2 });
    expect(owesSteps(listed("x", "X"))).toBe(false);
  });

  it("reads a plain item nested under a step as its detail, and a nested box as a step", () => {
    expect(
      owedSteps(
        body(
          "## Out-of-tree follow-ups",
          "- [x] Rotate the key",
          "  - the old key stays valid for a day",
          "  - [ ] revoke the old key after that day",
        ),
      ),
    ).toEqual({ open: 1, done: 1 });
  });

  it("never reads the heading or a step inside fenced code or an HTML comment", () => {
    expect(
      owesSteps(
        body(
          "## Summary",
          "The template reads:",
          "```markdown",
          "## Out-of-tree follow-ups",
          "- [ ] a step the template shows",
          "```",
          "<!--",
          "## Out-of-tree follow-ups",
          "- [ ] a commented-out step",
          "-->",
        ),
      ),
    ).toBe(false);
    expect(
      owedSteps(
        body(
          "## Out-of-tree follow-ups",
          "~~~",
          "- [ ] quoted, not a step",
          "~~~",
          "- [ ] Provision the bucket",
          "<!-- - [ ] a placeholder -->",
          "- [ ] ",
        ),
      ),
    ).toEqual({ open: 1, done: 0 });
  });

  it("keeps a sub-heading inside the section, and ends it at the next heading of its level", () => {
    expect(
      owedSteps(
        body(
          "## out-of-tree follow-ups",
          "### Before the merge",
          "- [ ] Add the secret",
          "### After the merge",
          "- [ ] Run the migration",
          "# Appendix",
          "- [ ] not a step",
        ),
      ),
    ).toEqual({ open: 2, done: 0 });
  });

  it("reads N/A as None, a thematic break as no step, and a setext heading as the section's", () => {
    expect(owesSteps(body("## Out-of-tree follow-ups", "- N/A"))).toBe(false);
    expect(
      owedSteps(
        body("## Out-of-tree follow-ups", "* * *", "- [ ] Rotate the key"),
      ),
    ).toEqual({ open: 1, done: 0 });
    expect(
      owedSteps(
        body(
          "Out-of-tree follow-ups",
          "----------------------",
          "- [ ] Rotate the key",
          "",
          "Test plan",
          "---------",
          "- [ ] not a step",
        ),
      ),
    ).toEqual({ open: 1, done: 0 });
  });

  it("says nothing of a description that was not read", () => {
    expect(owesSteps(undefined)).toBeNull();
  });
});

describe("the manual-operations label", () => {
  it("is manual-ops by default, the repository's own where it names one", () => {
    expect(manualOpsLabel({})).toEqual({ ok: true, value: "manual-ops" });
    expect(
      manualOpsLabel({ issue_tracker: { labels: { manual_ops: "ops-step" } } }),
    ).toEqual({ ok: true, value: "ops-step" });
  });

  it("is invalid, naming the field, where the tracker labels do not read", () => {
    const read = manualOpsLabel({
      issue_tracker: { labels: { manual_ops: 3 } },
    });
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.failure.reason).toContain("issue_tracker.labels.manual_ops");
  });
});
