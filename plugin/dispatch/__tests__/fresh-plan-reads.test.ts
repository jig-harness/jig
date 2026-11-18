import { expect, it } from "bun:test";
import assert from "node:assert/strict";
import {
  conn,
  gitHub,
  issueNode,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import { renderExecutionPlan } from "../../skills/do-item/scripts/lib/execution-plan.ts";
import { TrackerRateLimited } from "../../shared/outbound/budget.ts";
import { servedParentHold } from "../lib/sources/served-parents.ts";

const STEPS = Array.from({ length: 8 }, (_, i) => `#${i + 2}`);
const description =
  "## Execution Plan\n" +
  renderExecutionPlan({
    epic: "#1",
    intent: "deliver",
    steps: STEPS.map((issue, i) => ({
      issue,
      band: 1,
      lane: `l${i}`,
      gate: "agent",
    })),
    edges: [],
    gates: [],
  });

const node = (number: number) =>
  issueNode({
    number,
    labels: ["Todo"],
    body: number === 1 ? description : "",
    parent: number === 1 ? null : 1,
    extra: { subIssues: conn([]) },
  });

/** A GitHub tracker over the epic #1 and its eight planned steps; `batch` answers its batched reads. */
function fixture(batch: (numbers: number[]) => unknown = () => null) {
  return gitHub((call) => {
    if (call.op === "TrackerIssue")
      return {
        repository: { issue: node(Number(call.variables.number)) },
      };
    if (call.op === "TrackerDispatchIssues") {
      const numbers = Object.keys(call.variables)
        .filter((key) => /^number\d+$/.test(key))
        .map((key) => Number(call.variables[key]));
      return (
        batch(numbers) ??
        Object.fromEntries(
          numbers.map((number, i) => [`i${i}`, { issue: node(number) }]),
        )
      );
    }
    throw new Error(`unexpected operation ${call.op}`);
  });
}

const none = { get: () => null, set: () => undefined };

it("reads a fresh check's plan steps in one batch, not one issue read each", async () => {
  const f = fixture();
  const item = await f.t.poolIssue("#3");
  assert(item);
  const mark = f.calls.length;
  expect(await servedParentHold(f.t, item, none)).toBeNull();
  const ops = f.calls.slice(mark).map((call) => call.op);
  expect(ops.filter((op) => op === "TrackerIssue")).toEqual([]);
  // The item's own row (its parent), the parent's row (its plan), then the plan's steps.
  expect(ops).toEqual([
    "TrackerDispatchIssues",
    "TrackerDispatchIssues",
    "TrackerDispatchIssues",
  ]);
});

it("reads each key alone when the batch cannot answer it, and still checks the plan", async () => {
  const f = fixture(() => new Error("the batch failed"));
  const item = await f.t.poolIssue("#3");
  assert(item);
  expect(await servedParentHold(f.t, item, none)).toBeNull();
  expect(
    f.calls.filter((call) => call.op === "TrackerIssue").length,
  ).toBeGreaterThan(STEPS.length);
});

it("refuses every key of a batch the rate limit refused, without a read of each", async () => {
  const reset = Date.parse("2026-11-18T12:30:00.000Z");
  const f = fixture(
    () => new TrackerRateLimited("github", reset, "RATE_LIMITED"),
  );
  const item = await f.t.poolIssue("#3");
  assert(item);
  const mark = f.calls.length;
  await expect(servedParentHold(f.t, item, none)).rejects.toBeInstanceOf(
    TrackerRateLimited,
  );
  expect(
    f.calls.slice(mark).filter((call) => call.op === "TrackerIssue"),
  ).toEqual([]);
});

it("holds an item its parent plan does not place, read from the batch", async () => {
  const f = fixture();
  const item = await f.t.poolIssue("#20");
  assert(item);
  expect(await servedParentHold(f.t, item, none)).toBe(
    "waiting on the epic execution plan",
  );
});
