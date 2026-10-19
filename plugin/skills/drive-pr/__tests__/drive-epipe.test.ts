/**
 * An armed drive outlives the session that started it. When that session
 * closes the drive's console, every later console write fails with EPIPE;
 * the drive must carry on to its terminal state and record it in the
 * durable driver log.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import {
  binDir,
  gitCleanEnv,
  SCRIPTS,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { DRIVE_PACING_ENV, PASS_NOOP } from "./drive-loop-harness.ts";
import { spawn } from "node:child_process";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

useDrivePrSuite();

/** Close the actual console pipes after the driver's first write. */
async function closedConsole(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const child = spawn(process.execPath, argv, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  child.stdout.once("data", closed);
  child.stderr.once("data", closed);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode: code, stdout: "", stderr: "" };
}

describe("a closed console", () => {
  it("does not stop the drive, and the driver log records how it ended", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    });
    const result = await closedConsole(
      [join(SCRIPTS, "drive.ts"), "999", "--no-head-sync", "--", ...PASS_NOOP],
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          ...DRIVE_PACING_ENV,
        },
      },
    );
    expectSpawnExit(result, 0);
    const log = readFileSync(join(stateDir, "drive-pr-999.log"), "utf8");
    expect(log).toContain("converged");
  }, 60_000);

  it("does not stop the drive when the driver log could not start either", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    });
    // A directory squatting on the log's path: the log is unavailable.
    mkdirSync(join(stateDir, "drive-pr-999.log"), { recursive: true });
    const result = await closedConsole(
      [join(SCRIPTS, "drive.ts"), "999", "--no-head-sync", "--", ...PASS_NOOP],
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          ...DRIVE_PACING_ENV,
        },
      },
    );
    expectSpawnExit(result, 0);
  }, 60_000);
});
