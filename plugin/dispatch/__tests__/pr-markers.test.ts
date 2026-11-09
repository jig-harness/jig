/**
 * The marker labels and the follow-up states at the projection's seam: the
 * manual-operations label derived from the out-of-tree section both ways,
 * correcting a hand edit; `followup-failed` on a merged pull request whose
 * follow-up failed, replaced by `followed-up` once one is done; and
 * `automation` on a bot's pull request only. Also what says an automation
 * pull request needs work.
 */
import { describe, expect, it } from "bun:test";
import { planLabels, type ProjectionInput } from "../lib/actions/labels.ts";
import {
  checksFail,
  isAutomation,
  troubleOf,
  wantsAutomationLabel,
} from "../lib/automation.ts";
import { DEFAULT_LABELS } from "../lib/labels.ts";
import { markerChange } from "../lib/pr-markers.ts";
import type { MergedPr } from "../lib/types.ts";

const ON = { ...DEFAULT_LABELS, enabled: true };
const OWES = "## Out-of-tree follow-ups\n\n- [ ] Set the staging secret\n";
const NONE = "## Out-of-tree follow-ups\n\n_None_\n";
const DONE = "## Out-of-tree follow-ups\n\n- [x] Set the staging secret\n";
const BOT = { login: "app/regen-bot", bot: true };
const PERSON = { login: "maintainer", bot: false };

const merged = (number: number, labels: string[], body?: string): MergedPr => ({
  number,
  url: "",
  title: "",
  head: `feature/${number}`,
  mergedAt: "2026-11-01T00:00:00Z",
  labels,
  ...(body === undefined ? {} : { body }),
});

/** The projection over these pull requests, with no drive ledger and nothing serialized. */
function plan(input: Partial<ProjectionInput>) {
  return planLabels({
    config: ON,
    open: [],
    read: new Set((input.open ?? []).map((p) => p.number)),
    drives: [],
    merged: [],
    followedUp: new Set(),
    followupFailed: new Set(),
    manualOps: "manual-ops",
    ...input,
  });
}

describe("the owed-steps label", () => {
  it("is added to an open pull request that lists a step, and removed from one that lists none, a hand edit included", () => {
    const { changes } = plan({
      open: [
        { number: 1, labels: ["bug"], body: OWES },
        { number: 2, labels: ["manual-ops"], body: NONE },
        { number: 3, labels: ["manual-ops"], body: "No section at all." },
        { number: 4, labels: ["manual-ops"], body: OWES },
        { number: 5, labels: [], body: DONE },
      ],
    });
    expect(changes).toEqual([
      { pr: 1, add: ["manual-ops"], remove: [] },
      { pr: 2, add: [], remove: ["manual-ops"] },
      { pr: 3, add: [], remove: ["manual-ops"] },
    ]);
  });

  it("uses the repository's own label name, and is left alone where the description or the name did not read", () => {
    expect(
      plan({
        open: [{ number: 1, labels: [], body: OWES }],
        manualOps: "ops-step",
      }).changes,
    ).toEqual([{ pr: 1, add: ["ops-step"], remove: [] }]);
    expect(
      plan({ open: [{ number: 1, labels: ["manual-ops"] }] }).changes,
    ).toEqual([]);
    expect(
      plan({ open: [{ number: 1, labels: [], body: OWES }], manualOps: null })
        .changes,
    ).toEqual([]);
  });

  it("stays on a merged pull request until its follow-up is done, then leaves with followed-up in its place", () => {
    const pr = merged(7, ["jig:converged"], OWES);
    expect(plan({ merged: [pr] }).changes).toEqual([
      { pr: 7, add: ["manual-ops"], remove: [] },
    ]);
    const owing = merged(7, ["jig:converged", "manual-ops"], OWES);
    expect(plan({ merged: [owing], followedUp: new Set([7]) }).changes).toEqual(
      [
        { pr: 7, add: ["jig:followed-up"], remove: ["jig:converged"] },
        { pr: 7, add: [], remove: ["manual-ops"] },
      ],
    );
  });
});

describe("the failed follow-up's state", () => {
  it("labels a merged pull request whose follow-up failed, managed or not, and a later done replaces it with followed-up", () => {
    const failed = plan({
      merged: [merged(7, ["jig:converged"]), merged(8, [])],
      followupFailed: new Set([7, 8]),
    });
    expect(failed.changes).toEqual([
      { pr: 7, add: ["jig:followup-failed"], remove: ["jig:converged"] },
      { pr: 8, add: ["jig:followup-failed"], remove: [] },
    ]);
    expect(failed.report.states).toEqual([
      { target: "PR #7", state: "followup-failed" },
      { target: "PR #8", state: "followup-failed" },
    ]);
    const done = plan({
      merged: [merged(7, ["jig:followup-failed"])],
      followedUp: new Set([7]),
    });
    expect(done.changes).toEqual([
      { pr: 7, add: ["jig:followed-up"], remove: ["jig:followup-failed"] },
    ]);
  });

  it("leaves a merged pull request whose follow-up has not ended as it is", () => {
    expect(
      plan({ merged: [merged(7, ["jig:followup-failed"])] }).changes,
    ).toEqual([]);
  });
});

describe("the automation label", () => {
  it("goes on a bot's open pull request that carries no automation label, never on a person's, and is never removed", () => {
    const { changes } = plan({
      open: [
        { number: 1, labels: [], author: BOT },
        { number: 2, labels: ["automation:docs-sync"], author: BOT },
        { number: 3, labels: [], author: PERSON },
        { number: 4, labels: ["automation"], author: PERSON },
        { number: 5, labels: ["automation:docs-sync"], author: PERSON },
      ],
    });
    expect(changes).toEqual([{ pr: 1, add: ["automation"], remove: [] }]);
  });

  it("is not written on a merged pull request", () => {
    expect(
      markerChange(
        "manual-ops",
        { labels: [], author: BOT },
        {
          followedUp: false,
        },
      ),
    ).toEqual({ add: [], remove: [] });
  });

  it("is written apart from a state change, so a marker label the repository lacks never holds the state back", () => {
    expect(
      plan({ open: [{ number: 1, labels: ["jig:driving"], author: BOT }] })
        .changes,
    ).toEqual([
      { pr: 1, add: [], remove: ["jig:driving"] },
      { pr: 1, add: ["automation"], remove: [] },
    ]);
  });

  it("is written with the owed-steps label in one change", () => {
    expect(
      plan({ open: [{ number: 1, labels: [], author: BOT, body: OWES }] })
        .changes,
    ).toEqual([{ pr: 1, add: ["manual-ops", "automation"], remove: [] }]);
  });
});

describe("an automation pull request", () => {
  it("is one by its automation labels or its bot author", () => {
    expect(
      isAutomation({ labels: ["automation:docs-sync"], author: PERSON }),
    ).toBe(true);
    expect(isAutomation({ labels: ["automation"] })).toBe(true);
    expect(isAutomation({ labels: [], author: BOT })).toBe(true);
    expect(isAutomation({ labels: ["automationish"], author: PERSON })).toBe(
      false,
    );
    expect(wantsAutomationLabel({ labels: ["automation"], author: BOT })).toBe(
      false,
    );
  });

  it("needs work when a check fails, it conflicts with its base or a thread is unresolved", () => {
    expect(
      troubleOf({ mergeable: "MERGEABLE", failingChecks: false }),
    ).toBeNull();
    expect(troubleOf({ unresolvedThreads: 0 })).toBeNull();
    expect(troubleOf({ failingChecks: true })).toBe(
      "a check on its head fails",
    );
    expect(troubleOf({ mergeable: "CONFLICTING" })).toBe(
      "it conflicts with its base",
    );
    expect(troubleOf({ unresolvedThreads: 2 })).toBe(
      "2 review threads unresolved",
    );
  });

  it("reads a failed check from the listing's checks and from the query's rollup, and nothing from neither", () => {
    expect(
      checksFail([
        { __typename: "CheckRun", conclusion: "SUCCESS" },
        { __typename: "StatusContext", state: "ERROR" },
      ]),
    ).toBe(true);
    expect(
      checksFail([{ __typename: "CheckRun", conclusion: "TIMED_OUT" }]),
    ).toBe(true);
    expect(
      checksFail([
        { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "StatusContext", state: "PENDING" },
      ]),
    ).toBe(false);
    expect(checksFail({ state: "FAILURE" })).toBe(true);
    expect(checksFail({ state: "PENDING" })).toBe(false);
    expect(checksFail(null)).toBeUndefined();
  });
});
