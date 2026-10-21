/**
 * drive-pr suite: drive.ts deferring a required-check failure to the witness
 * wait rather than dispatching a CI-repair pass, and when it must not.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  REVIEWER_RUN,
  DORMANT_ARM,
  scratchClean,
  writeFixture as rawFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { PASS_TASK, runDriveIn, state } from "./drive-loop-harness.ts";

const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

useDrivePrSuite();

describe("drive.ts loop control", () => {
  it("defers a PURELY check-run required-check failure to the witness wait rather than dispatching CI-repair immediately", async () => {
    // The scenario `staleRequiredFailure` exists to protect: EVERY failing
    // name is both required and confirmed check-run-sourced, so the failure
    // could still be the stale, pre-unlabel snapshot rather than a fresh
    // result. Before this fix this never actually deferred — see the
    // sibling test above pinning why: the evidence never reached drive.ts at
    // all, so this predicate was unconditionally `false` in production and
    // every such case was dispatched to CI-repair immediately, spending
    // budget on a failure that might not even be real yet.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        // Forces `completedRequiredCi` false (hence `finalCi.code === 4`)
        // the same reliable way the "gives up with exit 4" fixture
        // above does: a required check whose fresh run completed `skipped`
        // is never a witness, regardless of id/watermark timing. Only these
        // two are skipped — 'Schema gate' keeps its real `failure` above —
        // so the aggregate verdict is `failing: Schema gate` while freshness
        // stays unconfirmed.
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "tests",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
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
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
        },
      },
    );
    expect(r.stderr).not.toContain("TASK=ci-repair");
    // The `staleRequiredFailure` wording variant, not the "nothing is
    // failing" one the all-skipped fixtures above assert —
    // distinct because this scenario has a real, named failing check.
    expect(r.stderr).toContain(
      "are required checks final-ready could not confirm are fresh",
    );
  }, 120_000);

  it("does NOT defer a required-named failure sourced from a legacy commit status, never a check-run", async () => {
    // `completedRequiredCi()` (ci-hold.ts) reads check-runs alone — it has no
    // notion of a commit status at all — so the freshness ambiguity
    // `finalCi.code === 4` encodes can never apply to a commit-status-sourced
    // failure, however it happens to be named. A legacy status context named
    // 'Schema gate' carries no watermark/timing uncertainty whatsoever, and
    // must be dispatched to CI-repair immediately rather than held back
    // behind the same exemption a genuine check-run gets.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        // Same `finalCi.code === 4` forcing technique as the sibling test
        // above — 'Schema gate' itself is left to its default PASSING
        // check-run (from `REQUIRED_CI_RUNS`), so the ONLY failing evidence
        // named 'Schema gate' is the legacy commit status below.
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "tests",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
      statuses: [{ context: "Schema gate", state: "failure", description: "" }],
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
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
        },
      },
    );
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toContain("DETAIL=Schema gate");
    expect(r.stderr).not.toContain(
      "no fresh exact-head required-check witness",
    );
  }, 120_000);

  it("does NOT defer a required-named failure that is BOTH an unconfirmed check-run AND a fresh legacy commit status under the same name", async () => {
    // The exact provenance gap: `failingCheckNames`
    // merges check-run and commit-status names with no per-entry provenance,
    // so `finalFailingCheckRunNames.includes('Schema gate')` was true for
    // BOTH the check-run occurrence and the status occurrence once a legacy
    // status shares the required check's exact name — the old predicate
    // could not tell them apart by name alone, and deferred the whole thing
    // to the witness wait even though the status-sourced failure carries no
    // freshness ambiguity whatsoever and is actionable right now.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        // Same `finalCi.code === 4` forcing technique as the sibling tests
        // above — only these two are skipped, so freshness of the required
        // check-run set stays unconfirmed.
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "tests",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
      // A SECOND, independent failure source under the IDENTICAL name — this
      // is what the old predicate could not distinguish from the check-run
      // occurrence above.
      statuses: [{ context: "Schema gate", state: "failure", description: "" }],
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
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          // Bounds a regression to a fast failure instead of a 30-minute
          // hang: against the unfixed predicate this fixture falls into the
          // witness wait instead of dispatching a repair.
          DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
        },
      },
    );
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toContain("DETAIL=Schema gate");
    expect(r.stderr).not.toContain(
      "no fresh exact-head required-check witness",
    );
  }, 120_000);
});
