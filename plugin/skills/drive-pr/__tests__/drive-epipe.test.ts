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
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

useDrivePrSuite();

// A shell pipeline: `head` reads the drive's first line and exits, closing
// the pipe the drive goes on writing to; the drive's own exit status comes
// back on standard error.
describe.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "a closed pipe to the driver is a POSIX SIGPIPE",
  ),
)("a closed console", () => {
  it("does not stop the drive, and the driver log records how it ended", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    });
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        '"$@" 2>&1 | head -n 1 >/dev/null; echo "exit=$((PIPESTATUS[0]))" >&2',
        "drive",
        join(SCRIPTS, "drive.ts"),
        "999",
        "--no-head-sync",
        "--",
        ...PASS_NOOP,
      ],
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
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [status] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(status.trim()).toBe("exit=0");
    const log = readFileSync(join(stateDir, "drive-pr-999.log"), "utf8");
    expect(log).toContain("converged");
  });

  it("does not stop the drive when the driver log could not start either", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    });
    // A directory squatting on the log's path: the log is unavailable.
    mkdirSync(join(stateDir, "drive-pr-999.log"), { recursive: true });
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        '"$@" 2>&1 | head -n 1 >/dev/null; echo "exit=$((PIPESTATUS[0]))" >&2',
        "drive",
        join(SCRIPTS, "drive.ts"),
        "999",
        "--no-head-sync",
        "--",
        ...PASS_NOOP,
      ],
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
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [status] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(status.trim()).toBe("exit=0");
  });
});
