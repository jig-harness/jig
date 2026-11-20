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
    branch: "main",
    ...over,
  };
}

const waiting = (ageMs: number) =>
  run(100, {
    status: "pending",
    conclusion: null,
    createdAt: isoFromMs(NOW - ageMs),
  });

// The holder started first; the cancelled runs since waited on it.
const holder = () =>
  run(96, {
    status: "in_progress",
    conclusion: null,
    createdAt: isoFromMs(NOW - 3 * STUCK_AFTER_MS),
  });
const cancelledBefore = [run(97), run(98), run(99)];
const queue = [holder(), ...cancelledBefore];

test("a run with no jobs, a running holder and only cancelled runs since, past the bound, is stuck", () => {
  const read = classifyRun(waiting(STUCK_AFTER_MS + 60_000), 0, queue, NOW);
  expect(read.state).toBe("stuck");
  expect(read.holder?.id).toBe(96);
  expect(read.before).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(read.reason).toContain("concurrency group is held");
});

test("the age is the blockage's, so a young pending run replacing old ones is still stuck", () => {
  const old = run(97, { createdAt: isoFromMs(NOW - 3 * STUCK_AFTER_MS) });
  const read = classifyRun(waiting(60_000), 0, [holder(), old], NOW);
  expect(read.state).toBe("stuck");
});

test("a blockage younger than the bound is still moving", () => {
  const young = [holder(), run(99, { createdAt: isoFromMs(NOW - 60_000) })];
  const read = classifyRun(waiting(30_000), 0, young, NOW);
  expect(read.state).toBe("moving");
  expect(read.reason).toContain("under the 30m bound");
});

test("a run that has jobs is moving, however old", () => {
  expect(classifyRun(waiting(5 * STUCK_AFTER_MS), 2, queue, NOW).state).toBe(
    "moving",
  );
});

test("a run with no running holder among the runs read is moving", () => {
  expect(
    classifyRun(waiting(5 * STUCK_AFTER_MS), 0, cancelledBefore, NOW).state,
  ).toBe("moving");
  expect(classifyRun(waiting(5 * STUCK_AFTER_MS), 0, [], NOW).state).toBe(
    "moving",
  );
});

test("a run that finished otherwise since the holder started keeps it moving, one from before the holder does not", () => {
  const since = [holder(), run(97), run(98, { conclusion: "success" })];
  expect(classifyRun(waiting(5 * STUCK_AFTER_MS), 0, since, NOW).state).toBe(
    "moving",
  );
  const earlier = [run(90, { conclusion: "success" }), ...queue];
  const read = classifyRun(waiting(5 * STUCK_AFTER_MS), 0, earlier, NOW);
  expect(read.state).toBe("stuck");
  expect(read.before).toEqual(["cancelled", "cancelled", "cancelled"]);
});

test("a completed run is finished with its conclusion", () => {
  const read = classifyRun(run(100, { conclusion: "success" }), 3, queue, NOW);
  expect(read.state).toBe("finished");
  expect(read.reason).toBe("the run completed: success");
});

test("the bound is the caller's", () => {
  expect(
    classifyRun(waiting(10 * 60_000), 0, queue, NOW, 5 * 60_000).state,
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
  head_branch: r.branch,
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
          workflow_runs: [stuck, ...queue].map(rest),
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

test("readDeployRun refuses to judge a queue from a run list it could not read whole", async () => {
  const base = "repos/{owner}/{repo}/actions";
  const read = await readDeployRun(
    100,
    forge(
      {
        [`${base}/runs/100`]: rest(waiting(STUCK_AFTER_MS * 2)),
        [`${base}/runs/100/jobs?per_page=1`]: { total_count: 0 },
        [`${base}/workflows/9/runs?per_page=20`]: {
          workflow_runs: [...cancelledBefore.map(rest), { id: 1 }],
        },
      },
      [],
    ),
    NOW,
  );
  expect(!read.ok && read.failure.reason).toContain("cannot be judged");
});

test("a queued run does not hold the queue", () => {
  const age = waiting(STUCK_AFTER_MS + 60_000);
  const queued = [
    run(96, { status: "queued", conclusion: null }),
    ...cancelledBefore,
  ];
  expect(classifyRun(age, 0, queued, NOW).state).toBe("moving");
});

test("a finished run is read from the run alone", async () => {
  const done = run(100, { conclusion: "success" });
  const asked: string[] = [];
  const read: ForgeRead = async (path) => {
    asked.push(path);
    return ok(rest(done));
  };
  const reading = await readDeployRun(100, read, NOW);
  expect(reading.ok && reading.value.state).toBe("finished");
  expect(asked).toHaveLength(1);
});

test("a running run of another branch holds the queue when the workflow shares one group", () => {
  const other = run(96, {
    status: "in_progress",
    conclusion: null,
    branch: "feature",
    createdAt: isoFromMs(NOW - 3 * STUCK_AFTER_MS),
  });
  const read = classifyRun(
    waiting(STUCK_AFTER_MS + 60_000),
    0,
    [other, ...cancelledBefore],
    NOW,
  );
  expect(read.state).toBe("stuck");
  expect(read.holder?.id).toBe(96);
});
