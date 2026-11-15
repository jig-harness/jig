/**
 * drive-pr suite: the closing report `drive.ts` writes at its stop when the
 * dispatcher's wrapper names a file for it (`JIG_DRIVER_REPORT`), and the
 * round each pass reads (`DRIVE_PR_ROUND`) to stamp its round report.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      "PR #999 parked: Did the arbiter escalate it?",
    );
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
