import { describe, expect, test } from "bun:test";
import { failed, ok } from "../../../shared/outcome.ts";
import type { CheckRunLite } from "../scripts/lib/ci-hold.ts";
import { parseCheckRuns } from "../scripts/lib/ci-hold.ts";
import {
  timedOutJobs,
  timeLimitOf,
  timeoutWording,
  type TimedOutJob,
} from "../scripts/lib/job-timeout.ts";
import type { WorkflowRun } from "../scripts/lib/status/workflow-runs.ts";

const HEAD = "a".repeat(40);
const annotation = (message: string) => [
  { path: ".github", annotation_level: "failure", message },
];

describe("the runner's time-limit annotation", () => {
  test("reads a limit given in minutes", () => {
    expect(
      timeLimitOf(
        annotation(
          "The job running on runner GitHub Actions 12 has exceeded the maximum execution time of 360 minutes.",
        ),
      ),
    ).toBe(360 * 60_000);
  });

  test("reads a limit given as a duration", () => {
    expect(
      timeLimitOf(
        annotation("The job has exceeded the maximum execution time of 5m0s"),
      ),
    ).toBe(5 * 60_000);
    expect(
      timeLimitOf(
        annotation(
          "The job running on runner ci-7 has exceeded the maximum execution time of 1h0m0s.",
        ),
      ),
    ).toBe(60 * 60_000);
  });

  test("a concurrency group's cancellation is not a time limit", () => {
    expect(
      timeLimitOf(
        annotation(
          "Canceling since a higher priority waiting request for 'ci-refs/pull/5/merge' exists",
        ),
      ),
    ).toBeNull();
    expect(timeLimitOf(annotation("The operation was canceled."))).toBeNull();
  });

  test("an answer that is not a list of annotations names no limit", () => {
    expect(timeLimitOf({ message: "exceeded" })).toBeNull();
    expect(timeLimitOf([{ message: 7 }])).toBeNull();
    expect(
      timeLimitOf(
        annotation("The job has exceeded the maximum execution time of soon"),
      ),
    ).toBeNull();
  });
});

describe("the check runs' list", () => {
  test("keeps when a run completed and how many annotations it carries", () => {
    const [run] = parseCheckRuns({
      check_runs: [
        {
          id: 3,
          name: "tests",
          head_sha: HEAD,
          status: "completed",
          conclusion: "cancelled",
          started_at: "2026-09-10T10:00:00Z",
          completed_at: "2026-09-10T10:30:04Z",
          output: { annotations_count: 2 },
        },
      ],
    }) ?? [undefined];
    expect(run).toMatchObject({
      completedAt: "2026-09-10T10:30:04Z",
      annotationsCount: 2,
    });
  });

  test("an absent annotation count is unknown, not zero", () => {
    const [run] = parseCheckRuns({
      check_runs: [
        {
          id: 3,
          name: "tests",
          head_sha: HEAD,
          status: "completed",
          conclusion: "cancelled",
          started_at: "2026-09-10T10:00:00Z",
        },
      ],
    }) ?? [undefined];
    expect(run).toMatchObject({ completedAt: null, annotationsCount: null });
  });
});

const job = (over: Partial<CheckRunLite> = {}): CheckRunLite => ({
  id: 11,
  name: "tests",
  headSha: HEAD,
  status: "completed",
  conclusion: "cancelled",
  startedAt: "2026-09-10T10:00:00Z",
  completedAt: "2026-09-10T10:30:04Z",
  annotationsCount: 1,
  appId: 15368,
  suiteId: 40,
  ...over,
});

const RUNS: WorkflowRun[] = [
  {
    id: 400,
    workflowId: 7,
    status: "completed",
    conclusion: "cancelled",
    checkSuiteId: 40,
    createdAt: "2026-09-10T09:59:00Z",
    startedAt: "2026-09-10T09:59:00Z",
    attempt: 1,
  },
];

const TIMEOUT = annotation(
  "The job running on runner r1 has exceeded the maximum execution time of 30 minutes.",
);

describe("which cancelled jobs ran out of time", () => {
  test("a job stopped at its limit is timed out, with its limit, run time and run", async () => {
    const asked: number[] = [];
    const jobs = await timedOutJobs([job()], RUNS, async (id) => {
      asked.push(id);
      return ok(TIMEOUT);
    });
    expect(asked).toEqual([11]);
    expect(jobs).toEqual([
      {
        name: "tests",
        checkRunId: 11,
        limitMs: 30 * 60_000,
        ranMs: 30 * 60_000 + 4_000,
        run: {
          id: 400,
          createdAt: "2026-09-10T09:59:00Z",
          conclusion: "cancelled",
          jobNames: ["tests"],
        },
      },
    ]);
  });

  test("a job with no annotation, or an unknown count, is not read", async () => {
    const asked: number[] = [];
    const read = async (id: number) => {
      asked.push(id);
      return ok(TIMEOUT);
    };
    expect(
      await timedOutJobs(
        [job({ annotationsCount: 0 }), job({ id: 12, annotationsCount: null })],
        RUNS,
        read,
      ),
    ).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("annotations that cannot be read leave the job a cancellation", async () => {
    expect(
      await timedOutJobs([job()], RUNS, async () =>
        failed("server-fault", "HTTP 502"),
      ),
    ).toEqual([]);
  });

  test("a job cancelled by its concurrency group is not timed out", async () => {
    expect(
      await timedOutJobs(
        [job({ completedAt: "2026-09-10T10:02:00Z" })],
        RUNS,
        async () =>
          ok(
            annotation(
              "Canceling since a higher priority waiting request for 'ci-5' exists",
            ),
          ),
      ),
    ).toEqual([]);
  });

  test("only a completed cancelled job is asked about", async () => {
    const asked: number[] = [];
    await timedOutJobs(
      [job({ conclusion: "failure" }), job({ status: "in_progress" })],
      RUNS,
      async (id) => {
        asked.push(id);
        return ok(TIMEOUT);
      },
    );
    expect(asked).toEqual([]);
  });
});

describe("the escalation's words", () => {
  const timedOut: TimedOutJob = {
    name: "test",
    checkRunId: 1,
    limitMs: 30 * 60_000,
    ranMs: 30 * 60_000 + 4_000,
    run: null,
  };

  test("name the job, its run time and its limit", () => {
    expect(timeoutWording(timedOut)).toBe(
      "job `test` ran 30m 4s and stopped at its 30-minute limit (timeout-minutes)",
    );
  });

  test("an unknown run time is left out", () => {
    expect(timeoutWording({ ...timedOut, ranMs: null })).toBe(
      "job `test` stopped at its 30-minute limit (timeout-minutes)",
    );
  });

  test("a limit of hours and seconds is written as a duration", () => {
    expect(
      timeoutWording({ ...timedOut, limitMs: 90_500, ranMs: 3_723_000 }),
    ).toBe(
      "job `test` ran 1h 2m 3s and stopped at its 1m 30s limit (timeout-minutes)",
    );
  });
});
