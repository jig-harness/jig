/**
 * drive-pr: a pass's round report (`round-report.ts`,
 * `lib/state/round-report.ts`): written only by a drive's pass, checked as
 * a closing report is, stamped with the pass's launch and round, and read
 * back only for that launch and round.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ClosingReport } from "../../../shared/closing-report.ts";
import {
  readRoundReport,
  ROUND_REPORT_SCHEMA,
  roundReportFile,
  writeRoundReport,
} from "../scripts/lib/state/round-report.ts";
import { cloneFile } from "../scripts/lib/state/artifacts.ts";
import { gitCleanEnv, SCRIPTS } from "./drive-pr-harness.ts";

const LAUNCH = "20261115T080000Z-abcdef01";

const REPORT: ClosingReport = {
  schema: "closing-report/v1",
  concluded: "Fixed the two threads the reviewer left; pushed.",
  suggested_next: { step: "The next round reads the review.", owner: "line" },
};

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "round-report-"));
}

function keep(dir: string, launch: string, round: number, pr = 999): void {
  writeRoundReport(dir, {
    schema: ROUND_REPORT_SCHEMA,
    pr,
    launch,
    round,
    at: "2026-11-15T08:00:00.000Z",
    report: REPORT,
  });
}

describe("a round report read back", () => {
  test("is read for its own launch and round", () => {
    const dir = stateDir();
    keep(dir, LAUNCH, 3);
    expect(readRoundReport(dir, "999", LAUNCH, 3)).toEqual(REPORT);
  });

  test("is never read when a later pass of the same round started after it was written", () => {
    const dir = stateDir();
    keep(dir, LAUNCH, 3);
    expect(
      readRoundReport(dir, "999", LAUNCH, 3, "2026-11-15T07:59:00.000Z"),
    ).toEqual(REPORT);
    expect(
      readRoundReport(dir, "999", LAUNCH, 3, "2026-11-15T08:00:01.000Z"),
    ).toBeNull();
  });

  test("is never read for another launch, another round or another pull request", () => {
    const dir = stateDir();
    keep(dir, LAUNCH, 3);
    expect(readRoundReport(dir, "999", "drive-pr 999 driver 4", 3)).toBeNull();
    expect(readRoundReport(dir, "999", LAUNCH, 4)).toBeNull();
    expect(readRoundReport(dir, "999", LAUNCH, 2)).toBeNull();
    expect(readRoundReport(dir, "998", LAUNCH, 3)).toBeNull();
  });

  test("is not read when it no longer passes the check, or does not read", () => {
    const dir = stateDir();
    const file = roundReportFile(dir, "999");
    writeFileSync(
      file,
      JSON.stringify({
        schema: ROUND_REPORT_SCHEMA,
        pr: 999,
        launch: LAUNCH,
        round: 3,
        at: "2026-11-15T08:00:00.000Z",
        report: { ...REPORT, concluded: "x".repeat(601) },
      }),
    );
    expect(readRoundReport(dir, "999", LAUNCH, 3)).toBeNull();
    writeFileSync(file, "{not json");
    expect(readRoundReport(dir, "999", LAUNCH, 3)).toBeNull();
    expect(readRoundReport(stateDir(), "999", LAUNCH, 3)).toBeNull();
  });

  test("is a file of the state directory's round-report family", () => {
    expect(cloneFile("drive-pr-999.round-report.json")).toEqual({
      pr: "999",
      family: "round-report",
    });
  });

  test("a round-finish file is of the round-finish family", () => {
    expect(cloneFile("drive-pr-999.round-finish.json")).toEqual({
      pr: "999",
      family: "round-finish",
    });
  });
});

async function roundReport(
  env: Record<string, string>,
  file: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [process.execPath, join(SCRIPTS, "round-report.ts"), file],
    {
      env: { ...gitCleanEnv(), ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("round-report.ts", () => {
  const passEnv = (dir: string) => ({
    DRIVE_PR_STATE_DIR: dir,
    DRIVE_PR_TARGET: "999",
    DRIVE_PR_ROUND: "2",
    JIG_LAUNCH: LAUNCH,
  });

  test("keeps a pass's report, redacted and stamped with its launch and round", async () => {
    const dir = stateDir();
    const file = join(dir, "report.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...REPORT,
        concluded: "Asked someone@example.com about the schema.",
      }),
    );
    const r = await roundReport(passEnv(dir), file);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toEqual({
      pr: 999,
      launch: LAUNCH,
      round: 2,
      report: "kept",
    });
    const kept = JSON.parse(readFileSync(roundReportFile(dir, "999"), "utf8"));
    expect(kept.launch).toBe(LAUNCH);
    expect(kept.round).toBe(2);
    expect(kept.report.concluded).toBe("Asked <redacted> about the schema.");
    expect(readRoundReport(dir, "999", LAUNCH, 2)?.concluded).toBe(
      "Asked <redacted> about the schema.",
    );
  });

  test("refuses a report the check refuses, naming the problem, and keeps nothing", async () => {
    const dir = stateDir();
    const file = join(dir, "report.json");
    writeFileSync(file, JSON.stringify({ ...REPORT, cause: "bored" }));
    const r = await roundReport(passEnv(dir), file);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("$.cause");
    expect(readRoundReport(dir, "999", LAUNCH, 2)).toBeNull();
  });

  test("refuses outside a drive's pass", async () => {
    const dir = stateDir();
    const file = join(dir, "report.json");
    writeFileSync(file, JSON.stringify(REPORT));
    const { DRIVE_PR_ROUND: _round, ...noRound } = passEnv(dir);
    const r = await roundReport(noRound, file);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("only a drive's pass writes a round report");
  });
});
