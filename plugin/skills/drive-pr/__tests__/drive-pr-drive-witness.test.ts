/**
 * drive-pr suite: drive.ts waiting for a fresh required-check witness — and
 * giving up when one can never arrive.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CheckRunFixture,
  REVIEWER_RUN,
  DORMANT_ARM,
  scratchClean,
  writeFixture as rawFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { PASS_LOUD, runDriveIn, state } from "./drive-loop-harness.ts";

const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

useDrivePrSuite();

describe("drive.ts loop control", () => {
  it("gives up with exit 4 when a fresh required-check witness can never arrive", async () => {
    // The unwitnessed shape no fall-through can decide: every required check's
    // fresh run completed `skipped`. That is PASSING to the aggregate verdict
    // (`PASSING_CONCLUSIONS` includes `skipped` — a skipped job is not a
    // failure) and NO WITNESS to `completedRequiredCi`, which wants a success.
    // Nothing red, nothing pending, and nothing that will ever become a witness
    // — so the wait cannot resolve by waiting, however long.
    //
    // The bound is set to 1 poll so the test observes the give-up rather than
    // the 30-minute default.
    const skipped = (name: string): CheckRunFixture => ({
      name,
      status: "completed",
      conclusion: "skipped",
      app: "github-actions",
      started: "2026-09-10T10:01:00Z",
    });
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        skipped("code-quality-and-build"),
        skipped("tests"),
        skipped("Schema gate"),
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
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: { DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1" } },
    );
    // Exit 4, not a terminal code: retry-safe, and a rerun genuinely can
    // produce the witness this drive could not find.
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("no fresh exact-head required-check witness");
    // It must NOT read as a CI failure — nothing here is red, and pointing at
    // /fix-ci would send an operator to fix code that is fine.
    expect(r.stderr).not.toContain("stopping for /fix-ci");
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("bounds a required check stuck queued/in-progress forever, not just skipped", async () => {
    // Another shape reaching the same unwitnessed state as the test above: a
    // required check that never leaves queued/in-progress. `ciVerdictOf()`
    // reports this as `pending: tests` (never `failing:`), and an
    // unconditional `await sleep(10); continue;` on every `pending:` verdict
    // at the top of the decision chain — regardless of `finalCi.code` — would
    // loop there forever, never once touching `witnessWaits`. A `pending:`
    // verdict under `finalCi.code === 4` (final-ready could not confirm
    // freshness — true here, since 'tests' has no completed run at all) falls
    // through to the SAME bounded wait a `skipped` required check hits.
    const inProgress = (name: string): CheckRunFixture => ({
      name,
      status: "in_progress",
      conclusion: null,
      app: "github-actions",
      started: "2026-09-10T10:01:00Z",
    });
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        inProgress("tests"),
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "success",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "success",
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
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: { DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1" } },
    );
    // Against the OLD code this hangs (the test would time out on the
    // unbounded `sleep(10)` loop) rather than exiting 4 — bounding it is the
    // whole fix.
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("no fresh exact-head required-check witness");
    expect(r.stderr).toContain("verdict has stayed 'pending: tests'");
    expect(r.stderr).not.toContain("stopping for /fix-ci");
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });
});
