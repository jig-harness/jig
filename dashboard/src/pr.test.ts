import { expect, test } from "bun:test";
import { prNumber, reconcileNeeds } from "./pr-state.ts";
import { fixture } from "../fixtures.ts";

class FixtureError extends Error {}

test("PR IDs copy just the number, tracker IDs stay intact", () => {
  expect(prNumber("PR #571")).toBe("571");
  expect(prNumber("ENG-4")).toBe(null);
});

test("a merged drive stop leaves needs-you, but a merged follow-up still needs a person", () => {
  const line = fixture("quiet").line;
  if (!line) throw new FixtureError("Missing fixture line");
  const common = {
    ...line.needs[0],
    repo: "acme/widget",
    target: "PR #7",
    pr: 7,
    url: "https://github.com/acme/widget/pull/7",
    decisions: [],
    workspaces: [],
  };
  line.needs = [
    { ...common, stage: "rearm", cause: "parked" },
    { ...common, stage: "followup", cause: "followup-failed" },
    { ...common, stage: "steer", cause: "nudge-unanswered" },
    {
      ...common,
      stage: "rearm",
      cause: "needs-person",
      stuckRecord: "stuck-drive",
    },
  ] as typeof line.needs;
  const facts = new Map([
    [
      "acme/widget#7",
      {
        state: "MERGED" as const,
        title: "Done",
        isDraft: false,
        url: common.url,
        checkedAt: new Date().toISOString(),
      },
    ],
  ]);
  expect(reconcileNeeds(line, facts).needs.map((n) => n.cause)).toEqual([
    "followup-failed",
    "nudge-unanswered",
    "needs-person",
  ]);
  expect(reconcileNeeds(line, new Map()).needs).toHaveLength(4);
});
