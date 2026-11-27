/**
 * drive-pr suite: the closing report `drive.ts` writes at its stop when the
 * dispatcher's wrapper names a file for it (`JIG_DRIVER_REPORT`), and the
 * round each pass reads (`DRIVE_PR_ROUND`) to stamp its round report.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readBoundedText } from "../../../shared/driver-report.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  ROUND_REPORT_SCHEMA,
  writeRoundReport,
} from "../scripts/lib/state/round-report.ts";
import {
  park,
  SCRIPTS,
  scratchClean,
  tmpRoot,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDrive, runDriveIn, PASS_NOOP } from "./drive-loop-harness.ts";
import { readState } from "./state-rows.ts";

useDrivePrSuite();

const LAUNCH = "20261115T080000Z-abcdef02";

/** Where the wrapper would name the report file, and the environment naming it. */
function dispatched(): { file: string; env: Record<string, string> } {
  const file = join(
    mkdtempSync(join(tmpRoot, "driver-report-")),
    "runs",
    LAUNCH,
    "drive-report.json",
  );
  return {
    file,
    env: {
      JIG_LAUNCH: LAUNCH,
      JIG_DRIVER_REPORT: file,
      DRIVE_PR_STALL_ROUNDS: "0",
    },
  };
}

function written(file: string) {
  const kept = JSON.parse(readFileSync(file, "utf8"));
  expect(kept.schema).toBe("driver-closing-report/v1");
  expect(kept.launch).toBe(LAUNCH);
  return kept.report;
}

/**
 * A dispatched drive whose every pass ends its round the way
 * finish-round.ts records `state` with `reason`, changing nothing the drive
 * can observe, run to its stall stop.
 */
async function stallEndingEvery(state: string, reason: string) {
  return await stallEndingWith(() => ({ state, reason }));
}

/**
 * A dispatched drive whose passes change nothing the drive can observe, run
 * to its stall stop: the pass of each round records the finish `byRound`
 * gives it, or none for `null`.
 */
async function stallEndingWith(
  byRound: (round: number) => { state: string; reason: string } | null,
) {
  const { file, env } = dispatched();
  const { dir, stateDir } = writeFixture(
    {
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
    },
    scratchClean.dir,
  );
  const finishes = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [i + 1, byRound(i + 1)]),
  );
  const recorder = join(dir, "record-finish.ts");
  writeFileSync(
    recorder,
    [
      `import { recordRoundFinish } from ${JSON.stringify(join(SCRIPTS, "lib", "state", "round-finish.ts"))};`,
      `import { resolveStateDir } from ${JSON.stringify(join(SCRIPTS, "lib", "state", "store.ts"))};`,
      `import { currentIso } from ${JSON.stringify(join(SCRIPTS, "..", "..", "..", "shared", "time.ts"))};`,
      `const finish = (${JSON.stringify(finishes)})[process.env.DRIVE_PR_ROUND ?? ""] ?? null;`,
      "if (finish !== null) {",
      "  const stateDir = process.env.DRIVE_PR_STATE_DIR || (await resolveStateDir());",
      '  recordRoundFinish(stateDir, "999", {',
      "    round: Number(process.env.DRIVE_PR_ROUND),",
      "    state: finish.state,",
      "    reason: finish.reason,",
      '    head: "a".repeat(40),',
      "    at: currentIso(),",
      "  });",
      "}",
    ].join("\n"),
  );
  const pass = [
    "sh",
    "-c",
    [
      ": pass for 999",
      `'${process.execPath}' '${recorder}' >&2`,
      "exit 0",
    ].join("\n"),
  ];
  const r = await runDriveIn(
    dir,
    stateDir,
    ["--max-rounds", "10", "--", ...pass],
    undefined,
    { env: { ...env, DRIVE_PR_STALL_ROUNDS: "2" } },
  );
  expectSpawnExit({ ...r, stdout: null }, 14);
  return { r, report: written(file), stateDir };
}

describe("drive.ts's closing report", () => {
  it("is written at a converged stop, with the registry's next step", async () => {
    const { file, env } = dispatched();
    const r = await runDrive(
      { threads: [], reviewedSha: scratchClean.head, head: scratchClean.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      undefined,
      { env },
    );
    expectSpawnExit({ ...r, stdout: null }, 0);
    const report = written(file);
    expect(report.concluded).toStartWith("PR #999's drive converged");
    expect(report.cause).toBeUndefined();
    expect(report.suggested_next).toEqual({
      step: "Merge the pull request once its required checks pass.",
      owner: "person",
      act: "Merge",
    });
  });

  it("ends with the last round report of this launch, which its pass stamped with its round", async () => {
    const { file, env } = dispatched();
    const { dir, stateDir } = writeFixture(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      scratchClean.dir,
    );
    const input = join(dir, "round-report-input.json");
    writeFileSync(
      input,
      JSON.stringify({
        schema: "closing-report/v1",
        concluded:
          "Declined the finding: it asks for a schema the repository does not have.",
        suggested_next: {
          step: "A person decides the schema.",
          owner: "person",
          act: "Decide",
        },
        question: "Should the repository adopt a schema?",
      }),
    );
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        'echo "pass for 999: ROUND=$DRIVE_PR_ROUND REPORT=$JIG_DRIVER_REPORT." >&2',
        `'${process.execPath}' '${join(SCRIPTS, "round-report.ts")}' '${input}' >&2`,
        "exit 0",
      ].join("\n"),
    ];
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--max-rounds", "1", "--", ...pass],
      undefined,
      { env },
    );
    expectSpawnExit({ ...r, stdout: null }, 6);
    // The pass reads its round; the wrapper's report file is the driver's alone.
    expect(r.stderr).toContain("ROUND=1 REPORT=.");
    const report = written(file);
    expect(report.concluded).toBe(
      "PR #999's drive used its round budget without converging (exit 6) Last round: Declined the finding: it asks for a schema the repository does not have.",
    );
    expect(report.cause).toBe("deadline");
    // A question comes from the drive's own state, never from a round report.
    expect(report.question).toBeUndefined();
  }, 120_000);

  it("never reads a round report stamped with another launch", async () => {
    const { file, env } = dispatched();
    const { dir, stateDir } = writeFixture(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      scratchClean.dir,
    );
    // An earlier launch's pass, on the same round this drive's pass runs,
    // left its report; this drive's pass writes none.
    writeRoundReport(stateDir, {
      schema: ROUND_REPORT_SCHEMA,
      pr: 999,
      launch: "20261114T080000Z-abcdef03",
      round: 1,
      at: "2026-11-14T08:00:00.000Z",
      report: {
        schema: "closing-report/v1",
        concluded: "An earlier launch's round.",
        suggested_next: { step: "None.", owner: "none" },
      },
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_NOOP],
      undefined,
      { env },
    );
    expectSpawnExit({ ...r, stdout: null }, 6);
    expect(written(file).concluded).toBe(
      "PR #999's drive used its round budget without converging (exit 6)",
    );
  }, 120_000);

  it("at a park, carries the parked item's question and framed decision", async () => {
    const { file, env } = dispatched();
    const { dir, stateDir } = writeFixture(
      {
        threads: [
          {
            id: "PRRT_p",
            path: "a.ts",
            bot: true,
            comments: [{ body: "a finding", bot: true }],
          },
        ],
      },
      scratchClean.dir,
    );
    await park(stateDir, "PRRT_p", "thread");
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--max-rounds", "2", "--", ...PASS_NOOP],
      undefined,
      { env },
    );
    expectSpawnExit({ ...r, stdout: null }, 8);
    const report = written(file);
    expect(report.question).toBe("Did the arbiter escalate it?");
    expect(report.decision.call.question).toBe("Did the arbiter escalate it?");
    expect(report.cause).toBe("needs-person");
    expect(report.suggested_next.act).toBe("Decide");
    expect(report.concluded).toBe(
      "PR #999 parked stopped at HITL_PARKED (exit 8): every remaining item awaits a human decision (1 thread(s), 0 summary finding(s), 0 other reversed provisional decision(s)) — handing back rather than re-arming; Did the arbiter escalate it?",
    );
  }, 120_000);

  it("at a stall whose passes all ended finish-round.ts CI_HOLD_WAIT, names that state and its reason instead of cause unknown", async () => {
    const { r, report } = await stallEndingEvery(
      "CI_HOLD_WAIT",
      "the CI hold is not ready on the current PR head",
    );
    expect(r.stderr).toContain(
      "Every one of those passes ended finish-round.ts CI_HOLD_WAIT: the CI hold is not ready on the current PR head",
    );
    expect(report.concluded).toStartWith(
      "PR #999's drive stalled: every stalled pass's round ended CI_HOLD_WAIT: the CI hold is not ready on the current PR head (exit 14)",
    );
    expect(report.cause).toBe("environment");
  }, 120_000);

  it("at a stall whose every pass's push failed, names the push's failure in the stop event and the report, and sends a person to fix it", async () => {
    const reason =
      "guarded-push.ts exited 1 (pre-push-gate): the pre-push hook's gates refused the push — typecheck failed";
    const { report, stateDir } = await stallEndingEvery("PUSH_FAILED", reason);
    expect(report.concluded).toStartWith(
      `PR #999's drive stalled: every stalled pass's round ended PUSH_FAILED: ${reason} (exit 14)`,
    );
    expect(report.cause).toBe("tool-failed");
    expect(report.suggested_next).toMatchObject({
      owner: "person",
      act: "Investigate",
    });
    expect(report.suggested_next.step).toContain("Fix what refuses the push");
    expect(report.suggested_next.step).not.toContain(
      "Read what the passes decided",
    );
    const state = readState(stateDir, "999") as {
      events: { kind: string; cause: string; finish?: unknown }[];
    };
    expect(state.events.findLast((e) => e.kind === "stop")).toMatchObject({
      cause: "14",
      finish: { state: "PUSH_FAILED", reason },
    });
  }, 120_000);

  it("at a stall whose passes ended differently, names each reason recorded and counts the pass that recorded none", async () => {
    const { r, report, stateDir } = await stallEndingWith((round) =>
      round === 2
        ? null
        : round === 1
          ? { state: "CI_HOLD_WAIT", reason: "the CI hold is not ready" }
          : {
              state: "HEAD_NOT_SYNCED",
              reason: "the head moved under the pass",
            },
    );
    const line =
      "round 1 CI_HOLD_WAIT: the CI hold is not ready; round 3 HEAD_NOT_SYNCED: the head moved under the pass; 1 of 3 passes recorded no reason";
    expect(r.stderr).toContain(`How those passes finished: ${line}`);
    expect(r.stderr).not.toContain("Every one of those passes ended");
    expect(report.concluded).toStartWith(
      `PR #999's drive stalled, its passes changing nothing: ${line} (exit 14)`,
    );
    const state = readState(stateDir, "999") as {
      events: { kind: string; cause: string; reasons?: unknown }[];
    };
    expect(state.events.findLast((e) => e.kind === "stop")).toMatchObject({
      cause: "14",
      reasons: { missing: 1, passes: 3 },
    });
  }, 120_000);

  it("is not written for a drive no wrapper named a file for", async () => {
    const { file, env } = dispatched();
    const { JIG_DRIVER_REPORT: _file, ...undispatched } = env;
    const r = await runDrive(
      { threads: [], reviewedSha: scratchClean.head, head: scratchClean.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      undefined,
      { env: undispatched },
    );
    expectSpawnExit({ ...r, stdout: null }, 0);
    expect(existsSync(file)).toBe(false);
  }, 120_000);
});

describe("readBoundedText", () => {
  it.skipIf(skipsOnWindows("file-system", "a FIFO is a POSIX file type"))(
    "refuses a FIFO at the path instead of blocking on it",
    () => {
      const fifo = join(mkdtempSync(join(tmpRoot, "fifo-")), "report.json");
      const made = spawnSync("mkfifo", [fifo]);
      expectSpawnExit({ ...made, exitCode: made.status }, 0);
      expect(() => readBoundedText(fifo, 1024)).toThrow("not a regular file");
    },
  );

  it("reads a regular file and refuses one over the limit", () => {
    const file = join(mkdtempSync(join(tmpRoot, "bounded-")), "report.json");
    writeFileSync(file, "abcd");
    expect(readBoundedText(file, 4)).toBe("abcd");
    expect(readBoundedText(file, 3)).toBeNull();
  });
});
