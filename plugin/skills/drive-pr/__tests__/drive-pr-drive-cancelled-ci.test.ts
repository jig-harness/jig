/**
 * drive-pr suite: drive.ts on a converged head whose final CI carries cancelled
 * checks. A cancelled check is waited for, bounded, and spends no CI-repair
 * pass; with nothing to replace it the drive ends not-judgeable, never
 * converged; a true failure beside it is repaired, naming the run that failed.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  binDir,
  type CheckRunFixture,
  DORMANT_ARM,
  gitCleanEnv,
  REVIEWER_RUN,
  SCRIPTS,
  scratchClean,
  useDrivePrSuite,
  writeFixture as rawFixture,
} from "./drive-pr-harness.ts";
import {
  runDriveIn,
  skipLongDriveFixture,
  state,
} from "./drive-loop-harness.ts";

const exits = (r: { stderr: string; exitCode: number }, code: number) =>
  expectSpawnExit({ ...r, stdout: null }, code);

/** A fixture, with the head's workflow runs in the API's own shape. */
const writeFixture = (
  f: Parameters<typeof rawFixture>[0] & {
    workflowRuns: Array<Record<string, unknown>>;
  },
) => {
  const written = rawFixture(f, scratchClean.dir);
  writeFileSync(
    join(written.dir, "workflow-runs.json"),
    JSON.stringify({ workflow_runs: f.workflowRuns }),
  );
  return written;
};

useDrivePrSuite();

// Echoes the whole repair channel, so a test can assert that the pass ran, what
// it was told, and, on a run that must spend no pass, that it did not.
const PASS_RUNS = [
  "sh",
  "-c",
  'echo "pass for 999: RAN_TH""E_PASS TASK=$DRIVE_PR_ROUND_TASK RUNS=[$DRIVE_PR_ROUND_FAILED_RUNS]" >&2; exit 0',
];

const OPENED = "2026-09-10T10:00:00Z";
const LATER = "2026-09-10T10:01:00Z";

const workflowRun = (
  id: number,
  conclusion: string,
  event = "pull_request",
  at = OPENED,
) => ({
  id,
  workflow_id: 7,
  event,
  status: "completed",
  conclusion,
  check_suite_id: id,
  created_at: at,
  run_started_at: at,
});

const check = (
  name: string,
  conclusion: string,
  suite: number,
  at = OPENED,
): CheckRunFixture => ({
  name,
  status: "completed",
  conclusion,
  app: "github-actions",
  started: at,
  completed_at: at,
  check_suite: { id: suite },
});

/** The consumer configuration of a repository with required checks and no hold. */
function noHoldOverlay(dir: string): string {
  const overlay = join(dir, "no-hold.yaml");
  writeFileSync(
    overlay,
    [
      "repository:",
      "  base_branch: develop",
      "review:",
      '  bots: ["review-bot[bot]"]',
      "  reviewer_app: example-review",
      "ci:",
      "  required_checks: [code-quality-and-build, tests, Schema gate]",
      "",
    ].join("\n"),
  );
  return overlay;
}

/** Drive a converged head with these checks and runs, in a repository without a hold. */
async function driveConverged(
  checkRuns: CheckRunFixture[],
  workflowRuns: Array<Record<string, unknown>>,
  env: Record<string, string> = {},
) {
  const { dir, stateDir } = writeFixture({
    threads: [],
    head: scratchClean.head,
    reviewedSha: scratchClean.head,
    checkRuns: [REVIEWER_RUN, DORMANT_ARM, ...checkRuns],
    workflowRuns,
  });
  return runDriveIn(
    dir,
    stateDir,
    ["--keep-draft", "--no-head-sync", "--", ...PASS_RUNS],
    undefined,
    { env: { JIG_OVERLAY: noHoldOverlay(dir), ...env } },
  );
}

/** Both the wait and the spent pass would show here: a cancelled check spends no pass. */
function expectNoRepairPass(stderr: string): void {
  expect(stderr).not.toContain("RAN_THE_PASS");
  expect(stderr).not.toContain("Running CI-repair pass");
  expect(stderr).not.toContain("stopping for /fix-ci");
}

describe.skipIf(skipLongDriveFixture)("drive.ts on cancelled checks", () => {
  it("ends not-judgeable on a required check cancelled with no successor", async () => {
    // The fixture's `tests` is green underneath: the older pass must not stand
    // in for the cancelled run, which is how a CI hold's held run reads. Without
    // a hold, final-ready counts the cancelled check as complete and exits 0, so
    // this also pins the bound: a loop that restarted it on that 0 never ends.
    const r = await driveConverged(
      [check("tests", "cancelled", 40)],
      [workflowRun(40, "cancelled")],
      { DRIVE_PR_FINAL_CI_WITNESS_POLLS: "2" },
    );
    exits(r, 4);
    expect(r.stderr).toContain(
      "waiting for a run to replace the cancelled check(s)",
    );
    expect(r.stderr).toContain("the verdict has stayed 'cancelled: tests'");
    expect(r.stderr).toContain("not a failure to repair, and not a pass");
    expectNoRepairPass(r.stderr);
    // Never reached a certified, green end.
    expect(r.stderr).not.toContain("merge-ready");
  });

  it("converges once a sibling run has replaced the cancelled one", async () => {
    // The measured shape: same head, same second, a matrix never expanded, and
    // the cancelled run holding the newest id for the required check's name.
    const r = await driveConverged(
      [
        check("tests", "cancelled", 40),
        check(`suite (linux, \${{ matrix.shard }}/3)`, "cancelled", 40),
        check("tests", "success", 41),
        check("suite (linux, 1/3)", "success", 41),
      ],
      [workflowRun(40, "cancelled"), workflowRun(41, "success")],
    );
    exits(r, 0);
    expectNoRepairPass(r.stderr);
    expect(r.stderr).not.toContain("waiting for a run to replace");
  });

  it("reads a workflow_dispatch run as replacing a pull_request run", async () => {
    const r = await driveConverged(
      [check("tests", "cancelled", 40), check("tests", "success", 41)],
      [
        workflowRun(40, "cancelled"),
        workflowRun(41, "success", "workflow_dispatch", LATER),
      ],
    );
    exits(r, 0);
    expectNoRepairPass(r.stderr);
  });

  it("repairs a failed job even when it started after cancellation", async () => {
    const r = await driveConverged(
      [
        { ...check("gates", "failure", 40), started: LATER },
        check("tests", "cancelled", 40),
      ],
      [workflowRun(40, "cancelled")],
      { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
    );
    exits(r, 1);
    expect(r.stderr).toContain("TASK=ci-repair RUNS=[40]");
  });

  it("repairs an aggregator in a run that was not cancelled", async () => {
    const r = await driveConverged(
      [
        { ...check("gates", "failure", 41), started: LATER },
        check("tests", "cancelled", 41),
      ],
      [workflowRun(41, "failure")],
      { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
    );
    expect(r.stderr).toContain("TASK=ci-repair RUNS=[41]");
    exits(r, 1);
  });

  it("tells the repair pass the failed run, not the cancelled sibling", async () => {
    // A cancelled run with a failed successor is a real failure, and the id the
    // pass is told is the failed one's, so it does not re-run the wrong run.
    const r = await driveConverged(
      [check("tests", "cancelled", 40), check("tests", "failure", 41)],
      [workflowRun(40, "cancelled"), workflowRun(41, "failure")],
      { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
    );
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
    expect(r.stderr).toContain("TASK=ci-repair RUNS=[41]");
    expect(r.stderr).toContain("Failed run(s) behind it: 41.");
    exits(r, 1);
  });

  it("names both failed runs when they are not one", async () => {
    const r = await driveConverged(
      [
        check("tests", "failure", 41),
        { ...check("lint", "failure", 42), app: "github-actions" },
      ],
      [workflowRun(41, "failure"), workflowRun(42, "failure")],
      { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
    );
    expect(r.stderr).toContain("TASK=ci-repair RUNS=[41 42]");
  });
});

describe("the proof announce-merge-ready relies on", () => {
  /** `final-ready --require-success` on a head with these checks and runs. */
  function finalReady(
    checkRuns: CheckRunFixture[],
    workflowRuns: Array<Record<string, unknown>>,
  ) {
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, ...checkRuns],
      workflowRuns,
    });
    return Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "ci-hold.ts"),
        "final-ready",
        "999",
        "--expect-head",
        scratchClean.head,
        "--require-success",
      ),
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          JIG_OVERLAY: noHoldOverlay(dir),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  it("holds for a required check whose cancelled run was replaced", async () => {
    // The cancelled check has the newest id for its name: only the workflow
    // runs say it no longer counts.
    await expectSpawnExited(
      finalReady(
        [check("tests", "cancelled", 40), check("tests", "success", 41)],
        [workflowRun(40, "cancelled"), workflowRun(41, "success")],
      ),
      0,
    );
  });

  it("does not certify a retained success while another run is being re-run", async () => {
    await expectSpawnExited(
      finalReady(
        [check("tests", "failure", 40), check("tests", "success", 41)],
        [
          {
            ...workflowRun(40, "failure", "pull_request", LATER),
            status: "queued",
            conclusion: null,
            run_attempt: 2,
          },
          {
            ...workflowRun(
              41,
              "success",
              "pull_request",
              "2026-09-10T10:02:00Z",
            ),
            run_attempt: 2,
          },
        ],
      ),
      4,
    );
  });

  it("does not hold for a required check cancelled with no successor", async () => {
    await expectSpawnExited(
      finalReady(
        [check("tests", "cancelled", 40)],
        [workflowRun(40, "cancelled")],
      ),
      4,
    );
  });
});

describe.skipIf(skipLongDriveFixture)("the CI hold", () => {
  it("ends not-judgeable on a held run that cancelled itself, with nothing to replace it", async () => {
    // The drive owns the hold and releases it, and no run answers the release:
    // the cancelled required check stays the newest for its name beside the
    // green under it. That must end neither converged nor in a repair.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, check("tests", "cancelled", 40)],
      workflowRuns: [workflowRun(40, "cancelled")],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expectSpawnExit(seeded, 0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_RUNS],
      undefined,
      { env: { DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1" } },
    );
    exits(r, 4);
    expect(r.stderr).toContain("CI hold label removed");
    expect(r.stderr).toContain("the verdict has stayed 'cancelled: tests'");
    expectNoRepairPass(r.stderr);
  });

  it("never tells a repair pass to re-run a run created under the hold's label", async () => {
    // `unit` failed in a held run and `lint` in a run after the release. A
    // re-run replays the event that carried the label, so only the second may
    // be named. The hold's own overlay and a settled release of it.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        check("lint", "failure", 42, "2026-09-10T10:05:00Z"),
        check("unit", "failure", 41, OPENED),
      ],
      workflowRuns: [
        workflowRun(41, "failure", "pull_request", OPENED),
        workflowRun(42, "failure", "pull_request", "2026-09-10T10:05:00Z"),
      ],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify(
        [
          ["LE_1", "labeled", "2026-09-10T09:59:00Z"],
          ["LE_2", "unlabeled", "2026-09-10T10:04:00Z"],
        ].map(([node_id, event, created_at]) => ({
          node_id,
          event,
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at,
        })),
      ),
    );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_RUNS],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain("TASK=ci-repair RUNS=[42]");
  });
});
