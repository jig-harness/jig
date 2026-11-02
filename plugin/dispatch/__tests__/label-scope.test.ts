/**
 * The label projection and the hold/scope filter at their seams: a pull
 * request in both listings gets the merged state only, and an action on a
 * held or out-of-scope pull request never survives `holdBack`.
 */
import { describe, expect, it } from "bun:test";
import { planLabels } from "../lib/actions/labels.ts";
import { DEFAULT_LABELS } from "../lib/labels.ts";
import { holdBack } from "../lib/plan.ts";
import type { Action } from "../lib/types.ts";

const act = (n: number): Action =>
  ({ target: `PR #${n}`, stage: "steer", reason: "nudge" }) as Action;

describe("holdBack", () => {
  it("reports a held target and silently drops an out-of-scope one", () => {
    const plan = { actions: [act(1), act(2), act(3)], held: [] as never[] };
    holdBack(plan as never, new Set([1]), new Set([2]));
    expect(plan.actions.map((a) => a.target)).toEqual(["PR #3"]);
    expect(plan.held).toHaveLength(1);
  });
});

describe("planLabels", () => {
  it("projects a pull request listed open and merged once, as merged", () => {
    const labels = ["jig:driving"];
    const pr = { number: 5, labels } as never;
    const { report } = planLabels({
      config: DEFAULT_LABELS,
      open: [pr],
      read: new Set([5]),
      drives: [],
      merged: [pr],
      followedUp: new Set(),
    } as never);
    expect(report.states.filter((s) => s.target === "PR #5")).toHaveLength(1);
  });
});
