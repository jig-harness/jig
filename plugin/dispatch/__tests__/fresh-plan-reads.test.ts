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
import { freshReads } from "../lib/sources/fresh-reads.ts";
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
    // The ancestry reads (one key each) succeed; the plan's steps batch fails.
    const f = fixture((numbers) => (numbers.length > 1 ? failure : null));
    const item = await f.t.poolIssue("#3");
    assert(item);
    const mark = f.calls.length;
    await expect(servedParentHold(f.t, item, none)).rejects.toBe(failure);
    expect(
      f.calls.slice(mark).filter((call) => call.op === "TrackerDispatchIssues"),
    ).toHaveLength(3);
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
    "not in #1's execution plan, so it waits on the need raised on #1 for a person",
  );
});

it("reads alone a key the tracker's pool batch left unanswered, not as absent", async () => {
  const singles: string[] = [];
  const issues: Record<string, ReturnType<typeof issue>> = {
    "ENG-1": issue("ENG-1"),
    "ENG-2": issue("ENG-2"),
    "ENG-3": issue("ENG-3"),
  };
  const tracker = {
    adapter: "linear",
    team: "ENG",
    poolIssues: async (keys: ReadonlyArray<string>) =>
      new Map(
        keys
          .filter((key) => key !== "ENG-2")
          .map((key) => [key, issues[key] ?? null]),
      ),
    poolIssue: async (key: string) => {
      singles.push(key);
      return issues[key] ?? null;
    },
  } as unknown as Tracker;
  const reads = freshReads(tracker);
  const [one, two, three] = await Promise.all([
    reads.pool("ENG-1"),
    reads.pool("ENG-2"),
    reads.pool("ENG-3"),
  ]);
  expect([one, two, three]).toEqual([
    issues["ENG-1"] ?? null,
    issues["ENG-2"] ?? null,
    issues["ENG-3"] ?? null,
  ]);
  expect(singles).toEqual(["ENG-2"]);
});

it("starts no request once the check's signal has aborted, and passes the signal to the reads it makes", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const singles: string[] = [];
  const controller = new AbortController();
  const tracker = {
    adapter: "linear",
    team: "ENG",
    poolIssues: async (_keys: ReadonlyArray<string>, signal?: AbortSignal) => {
      seen.push(signal);
      controller.abort();
      // A failure a narrower read may clear: only the aborted signal stops it.
      const error = new Error("not visible");
      error.name = "OutboundError";
      Object.assign(error, { code: "not-found" });
      throw error;
    },
    poolIssue: async (key: string) => {
      singles.push(key);
      return null;
    },
  } as unknown as Tracker;
  const reads = freshReads(tracker, { signal: controller.signal });
  await expect(reads.pool("ENG-1")).rejects.toBeDefined();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.aborted).toBe(true);
  expect(singles).toEqual([]);
});

it("starts no read of any kind when the check's signal was already aborted", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  controller.abort();
  const tracker = {
    adapter: "linear",
    team: "ENG",
    poolIssues: async () => {
      calls.push("batch");
      return new Map();
    },
    poolIssue: async () => {
      calls.push("single");
      return null;
    },
  } as unknown as Tracker;
  const reads = freshReads(tracker, { signal: controller.signal });
  assert(reads.once);
  await expect(reads.pool("ENG-1")).rejects.toBeDefined();
  await expect(
    reads.once("issue ENG-1", async () => {
      calls.push("body");
      return null;
    }),
  ).rejects.toBeDefined();
  expect(calls).toEqual([]);
});

it("refuses every pending key of a failed batch with the original failure", async () => {
  const failure = READ_FAILURES["rate limit"];
  const tracker = {
    adapter: "linear",
    team: "ENG",
    poolIssues: async () => {
      throw failure;
    },
    poolIssue: async () => {
      throw new Error("no key is read alone after a batch failure");
    },
  } as unknown as Tracker;
  const reads = freshReads(tracker);
  const settled = Promise.all(
    ["ENG-1", "ENG-2", "ENG-3"].map((key) =>
      reads.pool(key).then(
        () => null,
        (error: unknown) => error,
      ),
    ),
  );
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), 2000),
  );
  const outcome = await Promise.race([settled, timeout]);
  expect(outcome).toEqual([failure, failure, failure]);
});
