/**
 * drive-pr suite: a required check whose workflow never ran on the head.
 * `ci-hold.ts ensure` (through finish-round.ts) parks `missing-required-run`
 * past the grace from the head's push, naming the check and its workflow, and
 * keeps waiting while a run of it is queued or running. Shared fixtures live
 * in drive-pr-harness.ts and drive-pr-findings-finish-round-fixtures.ts.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import type { CheckRunLite } from "../scripts/lib/ci-hold.ts";
import {
  describeMissing,
  headPushedMs,
  MISSING_RUN_PARK_KEY,
  missingRequiredRuns,
  workflowForCheck,
} from "../scripts/lib/missing-required-run.ts";
import { readRoundFinishes } from "../scripts/lib/state/round-finish.ts";
import type { WorkflowRun } from "../scripts/lib/status/workflow-runs.ts";
import { parseMs } from "../../../shared/time.ts";
import { gitCleanEnv, useDrivePrSuite } from "./drive-pr-harness.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";
import { readState } from "./state-rows.ts";

useDrivePrSuite();

const HEAD = "c".repeat(40);
const REQUIRED = ["build", "tests"];
const PUSHED = "2026-09-10T10:00:00Z";
const GRACE = 15 * 60_000;

const run = (
  id: number,
  name: string,
  status = "completed",
  startedAt: string | null = PUSHED,
): CheckRunLite => ({
  id,
  name,
  headSha: HEAD,
  status,
  conclusion: status === "completed" ? "success" : null,
  startedAt,
  appId: null,
});

const workflowRun = (status: string, createdAt = PUSHED): WorkflowRun => ({
  id: 1,
  workflowId: 7,
  status,
  conclusion: status === "completed" ? "success" : null,
  checkSuiteId: 3,
  createdAt,
  startedAt: createdAt,
  attempt: 1,
});

const verdictAt = (
  minutesAfterPush: number,
  runs: CheckRunLite[],
  workflowRuns: WorkflowRun[] = [workflowRun("completed")],
  statuses: { context: string; state: string }[] = [],
) =>
  missingRequiredRuns({
    runs,
    statuses,
    workflowRuns,
    required: REQUIRED,
    head: HEAD,
    pushedMs: headPushedMs(runs, workflowRuns, HEAD, null),
    nowMs: parseMs(PUSHED) + minutesAfterPush * 60_000,
    graceMs: GRACE,
  });

describe("missingRequiredRuns", () => {
  it("names a required check with no run on the head past the grace", () => {
    expect(verdictAt(20, [run(1, "build")])).toEqual({
      kind: "missing",
      checks: ["tests"],
    });
  });

  it("waits for a required check whose run is queued or in progress", () => {
    for (const status of ["queued", "in_progress"])
      expect(
        verdictAt(60, [run(1, "build"), run(2, "tests", status, null)]),
      ).toEqual({ kind: "none" });
  });

  it("waits while a workflow run on the head has not finished, however long after the push", () => {
    const verdict = verdictAt(
      60,
      [run(1, "build")],
      [workflowRun("completed"), workflowRun("queued")],
    );
    expect(verdict.kind).toBe("wait");
  });

  it("waits within the grace from the head's push", () => {
    const verdict = verdictAt(10, [run(1, "build")]);
    expect(verdict).toMatchObject({ kind: "wait", checks: ["tests"] });
  });

  it("counts a commit status of the required context as its run", () => {
    expect(
      verdictAt(60, [run(1, "build")], undefined, [
        { context: "Tests", state: "pending" },
      ]),
    ).toEqual({ kind: "none" });
  });

  it("waits when nothing shows when the head was pushed", () => {
    expect(verdictAt(60, [], []).kind).toBe("wait");
  });

  it("dates the push by the head's earliest run, else its commit", () => {
    expect(
      headPushedMs(
        [run(1, "build", "completed", "2026-09-10T10:05:00Z")],
        [workflowRun("completed", "2026-09-10T10:01:00Z")],
        HEAD,
        0,
      ),
    ).toBe(parseMs("2026-09-10T10:01:00Z"));
    expect(headPushedMs([], [], HEAD, 1234)).toBe(1234);
    expect(headPushedMs([], [], HEAD, null)).toBeNull();
  });
});

describe("workflowForCheck", () => {
  const ci = {
    path: ".github/workflows/ci.yml",
    text: "on: push\njobs:\n  unit:\n    name: tests\n    runs-on: x\n  lint:\n    runs-on: x\n",
  };
  const matrix = {
    path: ".github/workflows/matrix.yml",
    text:
      "on: pull_request\njobs:\n  e2e:\n    name: End to end\n    runs-on: x\n  shard:\n    name: Shard $" +
      "{{ matrix.n }}\n    runs-on: x\n",
  };

  it("names the one workflow whose job reports the check, by name, id or matrix", () => {
    expect(workflowForCheck("tests", [ci, matrix])).toBe(ci.path);
    expect(workflowForCheck("lint", [ci, matrix])).toBe(ci.path);
    expect(workflowForCheck("End to end (chromium)", [ci, matrix])).toBe(
      matrix.path,
    );
    expect(workflowForCheck("Shard 3", [ci, matrix])).toBe(matrix.path);
  });

  it("says unknown when no workflow, or several, report it", () => {
    expect(workflowForCheck("deploy", [ci, matrix])).toBeNull();
    expect(
      workflowForCheck("tests", [
        ci,
        { ...ci, path: ".github/workflows/b.yml" },
      ]),
    ).toBeNull();
    expect(
      workflowForCheck("tests", [{ path: "bad.yml", text: "jobs: [" }]),
    ).toBeNull();
    expect(describeMissing("deploy", null)).toBe(
      "'deploy' (workflow: unknown)",
    );
  });
});

/** The drive's parked items, as the state keeps them. */
const parkedIn = (stateDir: string) =>
  (readState(stateDir, "999")?.parked ?? []) as Array<{
    key: string;
    reason: string;
    decision?: { call: { recommended: string } };
  }>;

describe("ci-hold.ts ensure on a required check that never ran", () => {
  const { finishRound, scratchWithOrigin } =
    createFindingsFinishRoundFixtures();

  /** The fixture's check runs without the required `tests`, or with it `queued`. */
  const withTests = (fixtureDir: string, queued: boolean) => {
    const path = join(fixtureDir, "check-runs.json");
    const runs = JSON.parse(readFileSync(path, "utf8")) as {
      check_runs: Array<Record<string, unknown>>;
    };
    runs.check_runs = queued
      ? runs.check_runs.map((r) =>
          r.name === "tests"
            ? { ...r, status: "queued", conclusion: null, started_at: null }
            : r,
        )
      : runs.check_runs.filter((r) => r.name !== "tests");
    writeFileSync(path, JSON.stringify(runs));
    writeFileSync(join(fixtureDir, "timeline.json"), "[]");
  };

  /** A scratch tree whose head holds the workflow that reports `tests`. */
  const withWorkflow = () => {
    const repo = scratchWithOrigin();
    const dir = join(repo.dir, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ci.yml"),
      "on:\n  push:\n    paths: [src/**]\njobs:\n  unit:\n    name: tests\n    runs-on: ubuntu-latest\n",
    );
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: repo.dir,
        env: gitCleanEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
    expectSpawnExit(git(["add", "."]), 0);
    expectSpawnExit(git(["commit", "-qm", "ci"]), 0);
    const head = git(["rev-parse", "HEAD"]).stdout.toString().trim();
    return { dir: repo.dir, head };
  };

  it("parks missing-required-run past the grace, naming the check and its workflow, and pushes nothing", async () => {
    const r = await finishRound({
      repo: withWorkflow(),
      fixture: { threads: [] },
      seedState: async ({ fixtureDir }) => withTests(fixtureDir, false),
    });
    expectSpawnExit(r, 8);
    expect(r.report.state).toBe("HITL_PARKED");
    expect(String(r.report.reason)).toContain(MISSING_RUN_PARK_KEY);
    expect(r.pushed).toBe("");
    expect(r.stderr).toContain("'tests' (workflow: .github/workflows/ci.yml)");
    const parked = parkedIn(r.stateDir);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      key: MISSING_RUN_PARK_KEY,
      kind: "finding",
      class: "human-decision",
    });
    expect(parked[0]?.reason).toContain(
      "'tests' (workflow: .github/workflows/ci.yml)",
    );
    expect(parked[0]?.decision?.call.recommended).toBe("repair");
  });

  it("names the workflow unknown when no workflow file identifies it", async () => {
    const r = await finishRound({
      fixture: { threads: [] },
      seedState: async ({ fixtureDir }) => withTests(fixtureDir, false),
    });
    expectSpawnExit(r, 8);
    const parked = parkedIn(r.stateDir);
    expect(parked[0]?.reason).toContain("'tests' (workflow: unknown)");
  });

  it("still waits with CI_HOLD_WAIT while the required check's run is queued", async () => {
    const r = await finishRound({
      fixture: { threads: [] },
      seedState: async ({ fixtureDir }) => withTests(fixtureDir, true),
      // A drive's pass: the round's finish is recorded for the stall stop.
      env: { DRIVE_PR_TARGET: "999", DRIVE_PR_ROUND: "3" },
    });
    expectSpawnExit(r, 4);
    expect(r.report.state).toBe("CI_HOLD_WAIT");
    expect(r.pushed).toBe("");
    expect(parkedIn(r.stateDir)).toEqual([]);
    expect(readRoundFinishes(r.stateDir, "999")).toMatchObject([
      { round: 3, state: "CI_HOLD_WAIT", reason: r.report.reason },
    ]);
  });
});
