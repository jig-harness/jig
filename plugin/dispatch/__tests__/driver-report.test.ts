/**
 * The wrapper and a drive's closing report: it names the driver a report
 * file in the run's own state directory, records what the driver wrote
 * there under the record (`by: driver`) before the exit, removes the file,
 * and prints the report as its last lines. A report for another launch, or
 * one the check refuses, is not recorded, and the wrapper says so; a drive
 * that wrote none leaves none.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ClosingReport } from "../../shared/closing-report.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { readEnded } from "../lib/launches.ts";
import { driverReportFile } from "../lib/run-report.ts";
import { type World, world } from "./fixtures.ts";
import { dispatchState, driveRuns, earlierRecord } from "./launch-fixtures.ts";

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const ID = "20261115T090000Z-abcdef21";
const TOKEN = "the-token";

const REPORT: ClosingReport = {
  schema: "closing-report/v1",
  concluded:
    "PR #7's drive used its round budget without converging (exit 6) Last round: Declined the schema finding.",
  suggested_next: {
    step: "Read the handoff file, then re-arm the drive.",
    owner: "person",
    act: "Investigate",
  },
  cause: "deadline",
  evidence: ["pr:#7"],
};

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

async function runWrapper(w: World) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${BUNFIG}`,
      RUN_TS,
      ID,
      TOKEN,
    ],
    { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => child.kill(), 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(deadline);
  return { exitCode, stdout, stderr };
}

/** A re-arm of PR #7 whose drive exits `MAX_ROUNDS` and writes `file` as its report, when given. */
function drive(file: unknown | null): World {
  const w = world();
  current = w;
  earlierRecord(w, { id: ID, account: "a", token: TOKEN });
  writeFileSync(join(w.dir, "drive-exit"), String(DRIVE_EXIT.MAX_ROUNDS));
  if (file !== null)
    writeFileSync(join(w.dir, "drive-report"), JSON.stringify(file));
  return w;
}

describe("the wrapper and a drive's closing report", () => {
  it("records the driver's report before the exit, removes its file and prints it as its last lines", async () => {
    const w = drive({
      schema: "driver-closing-report/v1",
      launch: ID,
      report: REPORT,
    });
    const r = await runWrapper(w);
    expectSpawnExit(r, DRIVE_EXIT.MAX_ROUNDS, "the wrapper");
    const path = driverReportFile(ID, dispatchState(w));
    expect(driveRuns(w)[0]?.report).toBe(path);
    expect(existsSync(path)).toBe(false);
    const ended = readEnded(ID, dispatchState(w));
    expect(ended?.report?.by).toBe("driver");
    expect(ended?.report?.report).toEqual(REPORT);
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines.slice(-4)).toEqual([
      "jig dispatch run: closing report (by driver):",
      `  concluded: ${REPORT.concluded}`,
      "  next (person, Investigate): Read the handoff file, then re-arm the drive.",
      "  cause: deadline",
    ]);
  });

  it("records nothing from a report for another launch, and says so", async () => {
    const w = drive({
      schema: "driver-closing-report/v1",
      launch: "20261115T090000Z-abcdef22",
      report: REPORT,
    });
    const r = await runWrapper(w);
    expectSpawnExit(r, DRIVE_EXIT.MAX_ROUNDS, "the wrapper");
    expect(r.stderr).toContain(
      `the driver's closing report was not recorded: the driver's report file is not one for launch record ${ID}`,
    );
    expect(readEnded(ID, dispatchState(w))?.report ?? null).toBeNull();
    expect(existsSync(driverReportFile(ID, dispatchState(w)))).toBe(false);
  });

  it("records nothing from a report the check refuses", async () => {
    const w = drive({
      schema: "driver-closing-report/v1",
      launch: ID,
      report: { ...REPORT, concluded: "x".repeat(601) },
    });
    const r = await runWrapper(w);
    expectSpawnExit(r, DRIVE_EXIT.MAX_ROUNDS, "the wrapper");
    expect(r.stderr).toContain("$.concluded: must be at most 600 characters");
    expect(readEnded(ID, dispatchState(w))?.report ?? null).toBeNull();
  });

  it("leaves no report for a drive that wrote none", async () => {
    const w = drive(null);
    const r = await runWrapper(w);
    expectSpawnExit(r, DRIVE_EXIT.MAX_ROUNDS, "the wrapper");
    expect(readEnded(ID, dispatchState(w))?.report ?? null).toBeNull();
    expect(r.stderr).not.toContain("closing report");
  });
});
