import { describe, expect, it } from "bun:test";
import {
  captureProcessTree,
  signalIdentityTargets,
  identityTargetsGone,
} from "../../../shared/process-tree.ts";
import type { ProcessRow } from "../../../shared/process-table.ts";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  driverStopRequested,
  requestDriverStop,
} from "../scripts/lib/stop-request.ts";
import {
  binDir,
  SCRIPTS,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { lockDirs, pollUntil } from "./drive-loop-harness.ts";

useDrivePrSuite();

describe("cooperative driver stop", () => {
  it("addresses one acquisition, so an older request cannot stop a successor", () => {
    const { stateDir } = writeFixture({ threads: [] });
    requestDriverStop(stateDir, "old-generation");
    expect(driverStopRequested(stateDir, "old-generation")).toBe(true);
    expect(driverStopRequested(stateDir, "new-generation")).toBe(false);
  });

  it("--stop cancels an active pass and releases its driver's locks", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_stop", path: "a.ts", bot: true }],
    });
    const { worktree, pr } = lockDirs(dir, stateDir);
    const marker = join(dir, "running-pass");
    const pass = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
      DRIVE_PR_STOP_GRACE_SEC: "15",
    };
    const driver = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "drive.ts"),
        "999",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        process.execPath,
        "-e",
        pass,
        "999",
      ),
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const output = Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
    ]);
    let captured: ProcessRow[] | null = null;
    try {
      expect(
        await pollUntil(async () => {
          if (driver.exitCode !== null) {
            const [stdout, stderr] = await output;
            expectSpawnExit(
              { exitCode: driver.exitCode, stdout, stderr },
              143,
              "driver exited before pass started",
            );
          }
          return existsSync(marker);
        }, 600),
      ).toBe(true);
      captured = await captureProcessTree(driver.pid);
      if (captured === null) {
        expect(captured).not.toBeNull();
        return;
      }
      expect(readdirSync(pr).filter((n) => n.startsWith("claim.")).length).toBe(
        1,
      );
      const stop = Bun.spawn(
        scriptArgv(join(SCRIPTS, "drives.ts"), "--stop", "999"),
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [stopOut, stopErr, stopCode] = await Promise.all([
        new Response(stop.stdout).text(),
        new Response(stop.stderr).text(),
        stop.exited,
      ]);
      expectSpawnExit(
        { exitCode: stopCode, stdout: stopOut, stderr: stopErr },
        0,
      );
      expect(stopOut).toContain("requested stop");
      const code = await driver.exited;
      const [stdout, stderr] = await output;
      expectSpawnExit({ exitCode: code, stdout, stderr }, 143);
      expect(stderr).toContain("received stop request");
      expect(existsSync(worktree)).toBe(false);
      expect(existsSync(pr)).toBe(false);
      expect(await identityTargetsGone(captured)).toBe(true);
    } finally {
      if (driver.exitCode === null) {
        const cleanupTargets =
          captured ?? (await captureProcessTree(driver.pid));
        if (cleanupTargets !== null)
          await signalIdentityTargets(cleanupTargets, "SIGKILL");
        else driver.kill();
      }
      await driver.exited;
      await output;
    }
  }, 60000);
});
