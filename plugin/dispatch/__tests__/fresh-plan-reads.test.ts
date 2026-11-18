import { expect, it } from "bun:test";
import assert from "node:assert/strict";
import {
  conn,
  gitHub,
  issueNode,
  READ_FAILURES,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { issue } from "./served-fixtures.ts";
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

const linearPlan =
  "## Execution Plan\n" +
  renderExecutionPlan({
    epic: "ENG-1",
    intent: "deliver",
    steps: ["ENG-2", "ENG-3"].map((issue, i) => ({
      issue,
      band: 1,
      lane: `l${i}`,
      gate: "agent",
    })),
    edges: [],
    gates: [],
  });

const description2 =
  "## Execution Plan\n" +
  renderExecutionPlan({
    epic: "#1",
    intent: "deliver",
    steps: ["#2", "#3"].map((issue, i) => ({
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

it("reads each key alone when one planned step cannot be seen, with the answer a single read gives", async () => {
  const hidden = (numbers: number[]) =>
    Object.fromEntries(
      numbers.map((number, i) => [
        `i${i}`,
        { issue: number === 9 ? null : node(number) },
      ]),
    );
  const f = gitHub((call) => {
    if (call.op === "TrackerIssue")
      return {
        repository: {
          issue:
            call.variables.number === 9
              ? null
              : node(Number(call.variables.number)),
        },
      };
    if (call.op === "TrackerDispatchIssues")
      return hidden(
        Object.keys(call.variables)
          .filter((key) => /^number\d+$/.test(key))
          .map((key) => Number(call.variables[key])),
      );
    throw new Error(`unexpected operation ${call.op}`);
  });
  const item = await f.t.poolIssue("#3");
  assert(item);
  const single = await servedParentHold(f.t, item, none, undefined, {
    pool: (key) => f.t.poolIssue(key),
  });
  expect(await servedParentHold(f.t, item, none)).toBe(single);
});

for (const [name, failure] of [
  ["the rate limit", READ_FAILURES["rate limit"]],
  [
    "a tracker limit",
    new TrackerRateLimited(
      "github",
      Date.parse("2026-11-18T12:30:00.000Z"),
      "RATE_LIMITED",
    ),
  ],
  ["no answer", READ_FAILURES.timeout],
  ["a malformed answer", new Error("the batch failed")],
] as const)
  it(`refuses every key of a batch that failed for ${name}, without a read of each`, async () => {
    const f = fixture(() => failure);
    const item = await f.t.poolIssue("#3");
    assert(item);
    const mark = f.calls.length;
    await expect(servedParentHold(f.t, item, none)).rejects.toBeDefined();
    expect(
      f.calls.slice(mark).filter((call) => call.op === "TrackerIssue"),
    ).toEqual([]);
  });

it("takes the tracker's pool batch where native rows carry no description", async () => {
  const asked: string[][] = [];
  const singles: string[] = [];
  const issues: Record<string, ReturnType<typeof issue>> = {
    "ENG-1": issue("ENG-1"),
    "ENG-3": issue("ENG-3"),
  };
  const tracker = {
    adapter: "linear",
    team: "ENG",
    dispatchSource: {
      issues: async () => {
        throw new Error("native rows are not read here");
      },
    },
    poolIssues: async (keys: ReadonlyArray<string>) => {
      asked.push([...keys]);
      return new Map(keys.map((key) => [key, issues[key] ?? null]));
    },
    poolIssue: async (key: string) => {
      singles.push(key);
      return issues[key] ?? null;
    },
    getIssue: async (key: string) => ({
      identifier: key,
      description: key === "ENG-1" ? linearPlan : "",
      parent: key === "ENG-3" ? { identifier: "ENG-1" } : null,
    }),
  } as unknown as Tracker;
  expect(
    await servedParentHold(tracker, issues["ENG-3"] as PoolIssue, none),
  ).toBeNull();
  expect(asked).toEqual([["ENG-1"], ["ENG-2", "ENG-3"]]);
  expect(singles).toEqual([]);
});

it("reads alone only a key a native batch left out", async () => {
  const singles: string[] = [];
  const issues: Record<string, ReturnType<typeof issue>> = {
    "#1": issue("#1"),
    "#2": issue("#2"),
    "#3": issue("#3"),
  };
  const rows = (key: string) => ({
    identifier: key,
    value: {
      description: key === "#1" ? description2 : "",
      parent: key === "#3" ? "#1" : null,
    },
  });
  const tracker = {
    adapter: "github",
    team: "acme/app",
    dispatchSource: {
      issues: async (keys: ReadonlyArray<string>) =>
        new Map(
          keys.filter((key) => key !== "#2").map((key) => [key, rows(key)]),
        ),
      describe: (raw: {
        value: { description: string; parent: string | null };
      }) => raw.value,
      project: async (raw: { identifier: string }) => issues[raw.identifier],
    },
    poolIssue: async (key: string) => {
      singles.push(key);
      return issues[key] ?? null;
    },
  } as unknown as Tracker;
  expect(
    await servedParentHold(tracker, issues["#3"] as PoolIssue, none),
  ).toBeNull();
  expect(singles).toEqual(["#2"]);
});

it("holds an item its parent plan does not place, read from the batch", async () => {
  const f = fixture();
  const item = await f.t.poolIssue("#20");
  assert(item);
  expect(await servedParentHold(f.t, item, none)).toBe(
    "waiting on the epic execution plan",
  );
});
