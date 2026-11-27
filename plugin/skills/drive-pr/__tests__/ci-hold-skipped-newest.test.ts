/**
 * drive-pr suite: a required check whose newest run on the head is a
 * completed skip, such as a label event's run on a workflow that skips the
 * required job. Before the hold is first added, the hold's precondition looks
 * past completed skips to the newest run that is not one; a queued or running
 * run still waits, a cancelled one is left to the cancelled-run recovery, and
 * a skip is never itself complete. Every other reader keeps the newest run.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type CheckRunLite,
  completedHoldPrecondition,
  completedRequiredCi,
} from "../scripts/lib/ci-hold.ts";
import { useDrivePrSuite } from "./drive-pr-harness.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";
import { readState } from "./state-rows.ts";

useDrivePrSuite();

const HEAD = "d".repeat(40);
const REQUIRED = ["tests", "Schema gate"];
const STARTED = "2026-09-10T10:01:00Z";
const LATER = "2026-09-10T10:03:00Z";

const run = (
  id: number,
  name: string,
  conclusion: string | null,
  status = "completed",
  startedAt: string | null = STARTED,
): CheckRunLite => ({
  id,
  name,
  headSha: HEAD,
  status,
  conclusion,
  startedAt,
  appId: null,
});

/** Each required check's run `first`, then a newer completed skip of it. */
const thenSkipped = (
  first: (id: number, name: string) => CheckRunLite,
): CheckRunLite[] =>
  REQUIRED.flatMap((name, i) => [
    first(i + 1, name),
    run(i + 100, name, "skipped", "completed", LATER),
  ]);

const neverHeld = (runs: CheckRunLite[]) =>
  completedHoldPrecondition(runs, REQUIRED, HEAD, null);

describe("the hold precondition on a head whose newest run is a skip", () => {
  it("looks past a newer skip to the completed run before it", () => {
    expect(neverHeld(thenSkipped((id, n) => run(id, n, "success")))).toBe(true);
  });

  it("counts a failed run before the skip as complete, since the precondition certifies no success", () => {
    expect(neverHeld(thenSkipped((id, n) => run(id, n, "failure")))).toBe(true);
  });

  it("still waits for a queued or running run, before or after the skip", () => {
    for (const status of ["queued", "in_progress"]) {
      expect(
        neverHeld(thenSkipped((id, n) => run(id, n, null, status, null))),
      ).toBe(false);
      const newer = REQUIRED.flatMap((name, i) => [
        run(i + 1, name, "success"),
        run(i + 100, name, "skipped", "completed", LATER),
        run(i + 200, name, null, status, null),
      ]);
      expect(neverHeld(newer)).toBe(false);
    }
  });

  it("leaves a cancelled run before the skip to the cancelled-run recovery", () => {
    expect(neverHeld(thenSkipped((id, n) => run(id, n, "cancelled")))).toBe(
      false,
    );
  });

  it("never reads a head with only skipped runs as complete", () => {
    const skips = REQUIRED.map((name, i) =>
      run(i + 100, name, "skipped", "completed", LATER),
    );
    expect(neverHeld(skips)).toBe(false);
  });

  it("needs every required check: one with only a skip keeps the head waiting", () => {
    const runs = [
      run(1, "tests", "success"),
      run(100, "tests", "skipped", "completed", LATER),
      run(101, "Schema gate", "skipped", "completed", LATER),
    ];
    expect(neverHeld(runs)).toBe(false);
  });

  it("keeps the newest run after a release: a skip after the unlabel is not complete", () => {
    const unlabel = {
      id: "LE_2",
      event: "unlabeled" as const,
      actor: "drive-user",
      createdAt: "2026-09-10T10:00:00Z",
    };
    const runs = thenSkipped((id, n) => run(id, n, "success"));
    expect(completedHoldPrecondition(runs, REQUIRED, HEAD, unlabel)).toBe(
      false,
    );
  });

  it("keeps the newest run for the final-CI witness, under a hold or not", () => {
    const runs = thenSkipped((id, n) => run(id, n, "success"));
    expect(completedRequiredCi(runs, REQUIRED, HEAD)).toBe(false);
    expect(completedRequiredCi(runs, REQUIRED, HEAD, undefined, true)).toBe(
      false,
    );
    expect(
      completedRequiredCi(
        runs,
        REQUIRED,
        HEAD,
        "2026-09-10T10:00:00Z",
        true,
        0,
        true,
      ),
    ).toBe(false);
  });
});

describe("finish-round on a head whose newest required run is a label event's skip", () => {
  const { finishRound } = createFindingsFinishRoundFixtures();
  const FIXTURE_REQUIRED = ["code-quality-and-build", "tests", "Schema gate"];

  /**
   * After each required check's successful run, a newer run of it that a
   * label event started: skipped, or still `queued`. No hold was ever added.
   */
  const withNewerRun = (fixtureDir: string, status: "skipped" | "queued") => {
    const path = join(fixtureDir, "check-runs.json");
    const runs = JSON.parse(readFileSync(path, "utf8")) as {
      check_runs: Array<Record<string, unknown>>;
    };
    const newer = runs.check_runs
      .filter((r) => FIXTURE_REQUIRED.includes(String(r.name)))
      .map((r, i) => ({
        ...r,
        id: 30_000 + i,
        status: status === "skipped" ? "completed" : "queued",
        conclusion: status === "skipped" ? "skipped" : null,
        created_at: LATER,
        started_at: status === "skipped" ? LATER : null,
      }));
    runs.check_runs = [...newer, ...runs.check_runs];
    writeFileSync(path, JSON.stringify(runs));
    writeFileSync(join(fixtureDir, "timeline.json"), "[]");
  };

  it("adds the hold and pushes instead of waiting on CI_HOLD_WAIT", async () => {
    const r = await finishRound({
      fixture: { threads: [] },
      seedState: async ({ fixtureDir }) => withNewerRun(fixtureDir, "skipped"),
    });
    expectSpawnExit(r, 0);
    expect(r.report.state).not.toBe("CI_HOLD_WAIT");
    expect(r.pushed).not.toBe("");
    const state = readState(r.stateDir, "999") as {
      ciHold: { phase: string };
    };
    expect(state.ciHold).toMatchObject({ phase: "held" });
  });

  it("still waits with CI_HOLD_WAIT while the newer run is queued", async () => {
    const r = await finishRound({
      fixture: { threads: [] },
      seedState: async ({ fixtureDir }) => withNewerRun(fixtureDir, "queued"),
    });
    expectSpawnExit(r, 4);
    expect(r.report.state).toBe("CI_HOLD_WAIT");
    expect(r.pushed).toBe("");
  });
});
