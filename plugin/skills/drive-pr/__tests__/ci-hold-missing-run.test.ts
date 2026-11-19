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
import { missingRunDecision } from "../scripts/lib/missing-required-run-live.ts";
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
const SETTLE = 5 * 60_000;

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

const workflowRun = (
  status: string,
  createdAt = PUSHED,
  updatedAt?: string,
): WorkflowRun => ({
  id: 1,
  workflowId: 7,
  status,
  conclusion: status === "completed" ? "success" : null,
  checkSuiteId: 3,
  createdAt,
  startedAt: createdAt,
  attempt: 1,
  ...(updatedAt === undefined ? {} : { updatedAt }),
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
    nowMs: parseMs(PUSHED) + minutesAfterPush * 60_000,
    graceMs: GRACE,
    settleMs: SETTLE,
  });

// A GitHub expression, spelled out so no plain string carries a template marker.
const expr = (e: string): string => `$\{{ ${e} }}`;

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

  it("waits within the settle window after the head's last workflow run finished, for a check a service posts after it", () => {
    const finishedLate = [
      workflowRun("completed", PUSHED, "2026-09-10T10:17:00Z"),
    ];
    expect(verdictAt(20, [run(1, "build")], finishedLate)).toMatchObject({
      kind: "wait",
      checks: ["tests"],
    });
    expect(verdictAt(23, [run(1, "build")], finishedLate).kind).toBe("missing");
  });

  it("counts a commit status of the required context as its run", () => {
    expect(
      verdictAt(60, [run(1, "build")], undefined, [
        { context: "Tests", state: "pending" },
      ]),
    ).toEqual({ kind: "none" });
  });

  it("waits while nothing has run on the head at all", () => {
    expect(verdictAt(60 * 24, [], [])).toMatchObject({
      kind: "wait",
      reason: "nothing has run on the head yet",
    });
  });

  it("dates the push by the head's earliest run", () => {
    expect(
      headPushedMs(
        [run(1, "build", "completed", "2026-09-10T10:05:00Z")],
        [workflowRun("completed", "2026-09-10T10:01:00Z")],
        HEAD,
      ),
    ).toBe(parseMs("2026-09-10T10:01:00Z"));
    expect(headPushedMs([], [], HEAD)).toBeNull();
  });
});

describe("missingRunDecision", () => {
  it("keeps every missing check in the decision when the question abbreviates them", () => {
    const named = ["a", "b", "c", "d", "e"].map((c) =>
      describeMissing(c, null),
    );
    const decision = missingRunDecision("f".repeat(40), named, 60_000);
    expect(decision.call.question).toContain("and 2 more");
    for (const n of named) expect(decision.steps.join("\n")).toContain(n);
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
      "{{ matrix.n }}\n    strategy:\n      matrix:\n        n: [1, 2, 3]\n    runs-on: x\n",
  };

  it("names the one workflow whose job reports the check, by name, id or matrix", () => {
    expect(workflowForCheck("tests", [ci, matrix])).toBe(ci.path);
    expect(workflowForCheck("lint", [ci, matrix])).toBe(ci.path);
    expect(workflowForCheck("End to end (chromium)", [ci, matrix])).toBe(
      matrix.path,
    );
    expect(workflowForCheck("Shard 3", [ci, matrix])).toBe(matrix.path);
  });

  it("does not attribute a check a templated name cannot be shown to expand to", () => {
    expect(
      workflowForCheck("Shard deployment approval", [ci, matrix]),
    ).toBeNull();
    expect(workflowForCheck("Shard 4", [ci, matrix])).toBeNull();
  });

  it("does not attribute a name that combines matrix keys or a matrix with exclusions", () => {
    const combined = {
      path: ".github/workflows/combined.yml",
      text: `on: push\njobs:\n  t:\n    name: ${expr("matrix.n")} ${expr("matrix.os")}\n    strategy:\n      matrix:\n        n: [1, 2]\n        os: [linux, windows]\n    runs-on: x\n`,
    };
    const excluded = {
      path: ".github/workflows/excluded.yml",
      text: `on: push\njobs:\n  t:\n    name: Build ${expr("matrix.os")}\n    strategy:\n      matrix:\n        os: [linux, windows]\n        exclude:\n          - os: windows\n    runs-on: x\n`,
    };
    expect(workflowForCheck("1 windows", [ci, combined])).toBeNull();
    expect(workflowForCheck("1 linux", [ci, combined])).toBeNull();
    expect(workflowForCheck("Build windows", [ci, excluded])).toBeNull();
    const repeated = {
      path: ".github/workflows/repeated.yml",
      text: `on: push\njobs:\n  t:\n    name: Pair ${expr("matrix.n")}-${expr("matrix.n")}\n    strategy:\n      matrix:\n        n: [1, 2]\n    runs-on: x\n`,
    };
    expect(workflowForCheck("Pair 1-2", [ci, repeated])).toBeNull();
    expect(workflowForCheck("Pair 1-1", [ci, repeated])).toBeNull();
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

  /**
   * A scratch tree whose head holds the workflow that reports `tests`, and
   * the head before that commit, `before`.
   */
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
    return { dir: repo.dir, head, before: repo.head };
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

  it("pushes unheld, parking nothing, when the round's own commits change the workflows", async () => {
    const tree = withWorkflow();
    const r = await finishRound({
      // The pull request's head predates the commit that adds the workflow.
      repo: { dir: tree.dir, head: tree.before },
      fixture: { threads: [] },
      seedState: async ({ fixtureDir }) => {
        withTests(fixtureDir, false);
        // The push is refused, so the round ends at it: no head to sync.
        writeFileSync(join(fixtureDir, "push-fails"), "");
      },
    });
    expectSpawnExit(r, 1);
    expect(r.report.state).toBe("PUSH_FAILED");
    expect(r.stderr).toContain("pushing unheld so the change can start them");
    // No hold was taken for the push, so a failed one has none to roll back.
    expect(r.stderr).not.toContain("CI hold label");
    expect(parkedIn(r.stateDir)).toEqual([]);
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
