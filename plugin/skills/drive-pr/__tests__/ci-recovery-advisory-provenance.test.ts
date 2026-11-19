import { describe, expect, test } from "bun:test";
import { cancelledRunRecovery } from "../scripts/lib/driver/ci-recovery.ts";
import type { FailingChecks } from "../scripts/lib/driver/infra-recovery.ts";
import type { DriveRoundContext } from "../scripts/lib/driver/round-context.ts";
import type { TimedOutJob } from "../scripts/lib/job-timeout.ts";

const run = (id: number, conclusion: string, jobNames: string[]) => ({
  id,
  conclusion,
  jobNames,
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
