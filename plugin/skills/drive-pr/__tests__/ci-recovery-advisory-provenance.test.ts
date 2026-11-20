import { describe, expect, test } from "bun:test";
import {
  cancelledRunRecovery,
  freshTimedOutInputs,
} from "../scripts/lib/driver/ci-recovery.ts";
import type { FailingChecks } from "../scripts/lib/driver/infra-recovery.ts";
import type { DriveRoundContext } from "../scripts/lib/driver/round-context.ts";
import type { TimedOutJob } from "../scripts/lib/job-timeout.ts";

const run = (id: number, conclusion: string, jobNames: string[]) => ({
  id,
  conclusion,
  jobNames,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("a timed-out job beside a failure in a run that was not cancelled", () => {
  test("is repaired with the provenance the advisory policy kept, not its own run", async () => {
    // The policy dropped workflow 300 (it also holds an advisory job), so the
    // set holds only the ordinary failure's run.
    const failing = {
      checkRunNames: ["build", "tests"],
      statusNames: [],
      runs: [run(100, "failure", ["build"])],
    } as unknown as FailingChecks;
    const timedOut: TimedOutJob = {
      name: "tests",
      checkRunId: 11,
      limitMs: 1_800_000,
      ranMs: 1_800_000,
      run: run(300, "cancelled", ["tests"]) as unknown as TimedOutJob["run"],
    };
    let told: FailingChecks | null = null;
    const exit = await cancelledRunRecovery(
      "failing: build, tests",
      false,
      { dryRun: false } as unknown as DriveRoundContext,
      "abc",
      failing,
      (failures) => {
        told = failures;
        return Promise.resolve(1);
      },
      [timedOut],
    );
    expect(exit).toBe(1);
    const runs = (told as unknown as FailingChecks).runs as { id: number }[];
    expect(runs.map((r) => r.id)).toEqual([100]);
  });
});

describe("the repair inputs while the reported failures' freshness is unconfirmed", () => {
  const timedOut: TimedOutJob = {
    name: "tests",
    checkRunId: 11,
    limitMs: 1_800_000,
    ranMs: 1_800_000,
    run: run(300, "cancelled", ["tests"]) as unknown as TimedOutJob["run"],
  };

  test("keep only the timed-out job and never restore a workflow the policy dropped", () => {
    // Workflow 300 was dropped by the policy (it shares a run with an
    // advisory job), so the cut set carries no run for the timed-out job.
    const failing = {
      checkRunNames: ["build", "tests"],
      statusNames: ["ci/legacy"],
      runs: [run(100, "failure", ["build"])],
    } as unknown as FailingChecks;
    const cut = freshTimedOutInputs(failing, [timedOut]);
    expect(cut?.finalVerdict).toBe("failing: tests");
    expect(cut?.failing.checkRunNames).toEqual(["tests"]);
    expect(cut?.failing.statusNames).toEqual([]);
    expect(cut?.failing.runs).toEqual([]);
  });

  test("keep the timed-out job's own run when the set still holds it alone", () => {
    const failing = {
      checkRunNames: ["build", "tests"],
      statusNames: [],
      runs: [run(100, "failure", ["build"]), run(300, "cancelled", ["tests"])],
    } as unknown as FailingChecks;
    const cut = freshTimedOutInputs(failing, [timedOut]);
    const runs = (cut?.failing.runs ?? []) as { id: number }[];
    expect(runs.map((r) => r.id)).toEqual([300]);
  });

  test("are null when the policy left no timed-out job", () => {
    const failing = {
      checkRunNames: ["build"],
      statusNames: [],
      runs: [run(100, "failure", ["build"])],
    } as unknown as FailingChecks;
    expect(freshTimedOutInputs(failing, [timedOut])).toBeNull();
  });
});
