/**
 * drive-pr suite: drive.ts on a converged head whose CI reports as a commit
 * status (Jenkins through its GitHub Branch Source plugin, for one), with no
 * workflow run to name. A failing status reaches the CI-repair pass with the
 * page it links to and the repository's CI-repair skill; a status whose build
 * was aborted is cancelled, as a cancelled check run is, and spends no pass.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { passEnv } from "../scripts/lib/driver/repair.ts";
import { CI_REPAIR_SPENT_EXIT } from "../scripts/lib/driver/settings.ts";
import {
  ciVerdictOf,
  failingStatusesOf,
} from "../scripts/lib/status/evidence.ts";
import {
  DORMANT_ARM,
  REVIEWER_RUN,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn, skipLongDriveFixture } from "./drive-loop-harness.ts";

const exits = (r: { stderr: string; exitCode: number }, code: number) =>
  expectSpawnExit({ ...r, stdout: null }, code);

useDrivePrSuite();

const JENKINS = "continuous-integration/jenkins/pr-merge";
const BUILD_URL = "https://ci.example/job/project/PR-999/3/display/redirect";

// Echoes what a repair pass is told, so a test can assert what reached it.
const PASS_STATUSES = [
  "sh",
  "-c",
  'echo "pass for 999: RAN_TH""E_PASS TASK=$DRIVE_PR_ROUND_TASK DETAIL=$DRIVE_PR_ROUND_TASK_DETAIL RUNS=[$DRIVE_PR_ROUND_FAILED_RUNS] STATUSES=$DRIVE_PR_ROUND_FAILED_STATUSES SKILL=$DRIVE_PR_ROUND_REPAIR_SKILL" >&2; exit 0',
];

/** A repository whose one required check is a Jenkins commit status, without a hold. */
function statusOverlay(dir: string, repairSkill: boolean): string {
  const overlay = join(dir, "status-ci.yaml");
  writeFileSync(
    overlay,
    [
      "repository:",
      "  base_branch: develop",
      "review:",
      '  bots: ["review-bot[bot]"]',
      "  reviewer_app: example-review",
      "dispatch:",
      "  person: drive-user",
      "ci:",
      `  required_checks: ["${JENKINS}"]`,
      ...(repairSkill ? ["  repair_skill: ci-support"] : []),
      "",
    ].join("\n"),
  );
  return overlay;
}

/** Drive a converged head whose only CI is this Jenkins status. */
function driveWithStatus(
  status: { state: string; description: string },
  env: Record<string, string>,
  repairSkill = true,
) {
  // The fixture writes each status as the API gives it, the link included.
  const jenkins = { context: JENKINS, target_url: BUILD_URL, ...status };
  const { dir, stateDir } = writeFixture(
    {
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM],
      statuses: [jenkins],
    },
    scratchClean.dir,
  );
  return runDriveIn(
    dir,
    stateDir,
    ["--keep-draft", "--no-head-sync", "--", ...PASS_STATUSES],
    undefined,
    { env: { JIG_OVERLAY: statusOverlay(dir, repairSkill), ...env } },
  );
}

describe.skipIf(skipLongDriveFixture)("drive.ts on a commit-status CI", () => {
  it("tells the repair pass the failing status, its URL and the repair skill", async () => {
    const r = await driveWithStatus(
      { state: "failure", description: "This commit cannot be built" },
      { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
    );
    exits(r, CI_REPAIR_SPENT_EXIT);
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
    expect(r.stderr).toContain(
      `TASK=ci-repair DETAIL=${JENKINS} RUNS=[] STATUSES=${JSON.stringify([
        { context: JENKINS, target_url: BUILD_URL },
      ])} SKILL=ci-support`,
    );
    expect(r.stderr).toContain(
      `Failed commit status: ${JENKINS} (${BUILD_URL}).`,
    );
    expect(r.stderr).toContain("loads the CI-repair skill ci-support");
  });

  it("names no repair skill when the repository sets none", async () => {
    const r = await driveWithStatus(
      { state: "error", description: "Something is wrong with the build" },
      { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
      false,
    );
    exits(r, CI_REPAIR_SPENT_EXIT);
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toMatch(/SKILL=\n/u);
  });

  it("reads an aborted build as cancelled and spends no repair pass", async () => {
    const r = await driveWithStatus(
      {
        state: "error",
        description: "The build of this commit was aborted",
      },
      { DRIVE_PR_CI_REPAIR_ROUNDS: "1", DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1" },
    );
    exits(r, 4);
    expect(r.stderr).toContain(
      `the verdict has stayed 'cancelled: ${JENKINS}'`,
    );
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).not.toContain("Running CI-repair pass");
  });
});

describe("the CI verdict over commit statuses", () => {
  const jenkins = (state: string, description: string) => ({
    context: JENKINS,
    state,
    description,
    targetUrl: BUILD_URL,
  });
  const lint = { context: "lint", state: "failure", description: "" };

  it("reads an aborted build as cancelled, below a failure", () => {
    const aborted = jenkins("error", "The build of this commit was aborted");
    expect(ciVerdictOf([], [aborted], false, "abc")).toBe(
      `cancelled: ${JENKINS}`,
    );
    expect(ciVerdictOf([], [aborted, lint], false, "abc")).toBe(
      "failing: lint",
    );
    expect(failingStatusesOf([aborted, lint])).toEqual([
      { context: "lint", target_url: null },
    ]);
  });

  it("keeps a failing status's URL for the repair pass", () => {
    const red = jenkins("failure", "This commit cannot be built");
    expect(ciVerdictOf([], [red], false, "abc")).toBe(`failing: ${JENKINS}`);
    expect(failingStatusesOf([red])).toEqual([
      { context: JENKINS, target_url: BUILD_URL },
    ]);
    expect(failingStatusesOf(null)).toBeNull();
  });

  it("hands the pass its statuses as JSON and its skill by name", () => {
    const env = passEnv({
      task: "ci-repair",
      detail: JENKINS,
      failedStatuses: [{ context: JENKINS, target_url: BUILD_URL }],
      repairSkill: "ci-support",
    });
    expect(JSON.parse(env.DRIVE_PR_ROUND_FAILED_STATUSES ?? "")).toEqual([
      { context: JENKINS, target_url: BUILD_URL },
    ]);
    expect(env.DRIVE_PR_ROUND_REPAIR_SKILL).toBe("ci-support");
  });

  it("removes inherited repair variables from an ordinary pass", () => {
    const repair = join(import.meta.dir, "../scripts/lib/driver/repair.ts");
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { passEnv } from ${JSON.stringify(repair)};
const env = passEnv();
console.log(JSON.stringify([env.DRIVE_PR_ROUND_FAILED_STATUSES ?? null, env.DRIVE_PR_ROUND_REPAIR_SKILL ?? null]));`,
      ],
      {
        env: {
          ...process.env,
          DRIVE_PR_ROUND_FAILED_STATUSES: "[]",
          DRIVE_PR_ROUND_REPAIR_SKILL: "ci-support",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(child, 0);
    expect(JSON.parse(child.stdout.toString())).toEqual([null, null]);
  });
});
