import { expect, test } from "bun:test";
import {
  classifyRun,
  type ForgeRead,
  readDeployRun,
  type RunFacts,
  STUCK_AFTER_MS,
} from "../scripts/lib/deploy.ts";
import { failed, ok } from "../../../shared/outcome.ts";
import { isoFromMs, parseMs } from "../../../shared/time.ts";

const NOW = parseMs("2026-11-19T12:00:00.000Z");

function run(id: number, over: Partial<RunFacts> = {}): RunFacts {
  return {
    id,
    url: `https://github.com/o/r/actions/runs/${id}`,
    status: "completed",
    conclusion: "cancelled",
    createdAt: isoFromMs(NOW - (100 - id) * 60_000),
    workflowId: 9,
    ...over,
  };
}

const waiting = (ageMs: number) =>
  run(100, {
    status: "pending",
    conclusion: null,
    createdAt: isoFromMs(NOW - ageMs),
  });

const cancelledBefore = [run(97), run(98), run(99)];

test("a run with no jobs past the bound, every run before it cancelled, is stuck", () => {
  const read = classifyRun(
    waiting(STUCK_AFTER_MS + 60_000),
    0,
    [waiting(STUCK_AFTER_MS + 60_000), ...cancelledBefore],
    NOW,
  );
  expect(read.state).toBe("stuck");
  expect(read.before).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(read.reason).toContain("concurrency group is held");
});

test("a run with no jobs younger than the bound is still moving", () => {
  const read = classifyRun(
    waiting(STUCK_AFTER_MS - 60_000),
    0,
    cancelledBefore,
    NOW,
  );
  expect(read.state).toBe("moving");
  expect(read.reason).toContain("under the 30m bound");
});

test("a run that has jobs is moving, however old", () => {
  expect(
    classifyRun(waiting(5 * STUCK_AFTER_MS), 2, cancelledBefore, NOW).state,
  ).toBe("moving");
});

test("a run whose predecessors did not all end cancelled is moving", () => {
  const before = [run(97), run(98, { conclusion: "success" }), run(99)];
  expect(classifyRun(waiting(5 * STUCK_AFTER_MS), 0, before, NOW).state).toBe(
    "moving",
  );
  expect(classifyRun(waiting(5 * STUCK_AFTER_MS), 0, [], NOW).state).toBe(
    "moving",
  );
});

test("only finished runs older than the waited-for one count as its predecessors", () => {
  const newer = run(101, { conclusion: "success" });
  const queued = run(96, { status: "queued", conclusion: null });
  const read = classifyRun(
    waiting(5 * STUCK_AFTER_MS),
    0,
    [newer, queued, ...cancelledBefore, run(95, { conclusion: "success" })],
    NOW,
  );
  expect(read.before).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(read.state).toBe("stuck");
});

test("a completed run is finished with its conclusion", () => {
  const read = classifyRun(
    run(100, { conclusion: "success" }),
    3,
    cancelledBefore,
    NOW,
  );
  expect(read.state).toBe("finished");
  expect(read.reason).toBe("the run completed: success");
});

test("the bound is the caller's", () => {
  expect(
    classifyRun(waiting(10 * 60_000), 0, cancelledBefore, NOW, 5 * 60_000)
      .state,
  ).toBe("stuck");
});

/** A forge that answers each path from `answers`, recording what it was asked. */
function forge(answers: Record<string, unknown>, asked: string[]): ForgeRead {
  return async (path) => {
    asked.push(path);
    return path in answers
      ? ok(answers[path])
      : failed("unreadable", `no answer for ${path}`);
  };
}

const rest = (r: RunFacts) => ({
  id: r.id,
  html_url: r.url,
  status: r.status,
  conclusion: r.conclusion,
  created_at: r.createdAt,
  workflow_id: r.workflowId,
});

test("readDeployRun reads the run, its job count and its workflow's runs", async () => {
  const stuck = waiting(STUCK_AFTER_MS * 2);
  const asked: string[] = [];
  const base = "repos/{owner}/{repo}/actions";
  const read = await readDeployRun(
    100,
    forge(
      {
        [`${base}/runs/100`]: rest(stuck),
        [`${base}/runs/100/jobs?per_page=1`]: { total_count: 0, jobs: [] },
        [`${base}/workflows/9/runs?per_page=20`]: {
          workflow_runs: [stuck, ...cancelledBefore].map(rest),
        },
      },
      asked,
    ),
    NOW,
  );
  expect(read.ok && read.value.state).toBe("stuck");
  expect(asked).toHaveLength(3);
});

test("readDeployRun passes a forge failure on and refuses an answer that is not a run", async () => {
  const none = await readDeployRun(5, forge({}, []), NOW);
  expect(!none.ok && none.failure.code).toBe("unreadable");
  const odd = await readDeployRun(
    5,
    forge({ "repos/{owner}/{repo}/actions/runs/5": { id: "x" } }, []),
    NOW,
  );
  expect(!odd.ok && odd.failure.reason).toContain("is not a run");
});
