import { describe, expect, it } from "bun:test";
import {
  captureProcessTree,
  signalIdentityTargets,
  identityTargetsGone,
} from "../../../shared/process-tree.ts";
import type { ProcessRow } from "../../../shared/process-table.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  it("cooperative stop waits for idle-driver helper cancellation before releasing resources", async () => {
    const { dir } = writeFixture({ threads: [] });
    const released = join(dir, "released");
    const helperPid = join(dir, "helper-pid");
    const cancelled = join(dir, "cancelled");
    const mutation = join(dir, "next-mutation");
    const cleanupModule = new URL("../../../shared/cleanup.ts", import.meta.url)
      .href;
    const driveModule = new URL("../scripts/drive.ts", import.meta.url).href;
    const requestModule = new URL(
      "../scripts/lib/stop-request.ts",
      import.meta.url,
    ).href;
    const script = `
      import {writeFileSync,existsSync} from 'node:fs';
      import {registerCleanup,registerSignalHandler} from ${JSON.stringify(cleanupModule)};
      import {installStopControls,finishDriverPassRegistrations} from ${JSON.stringify(driveModule)};
      import {requestDriverStop} from ${JSON.stringify(requestModule)};
      const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)',${JSON.stringify(helperPid)}],{stdout:'ignore',stderr:'ignore'});
      writeFileSync(${JSON.stringify(helperPid)},String(child.pid));
      registerCleanup(()=>writeFileSync(${JSON.stringify(released)},existsSync(${JSON.stringify(cancelled)})?'cancelled':'early'));
      registerSignalHandler(async()=>{
        await new Promise(resolve=>setTimeout(resolve,300));
        child.kill();await child.exited;
        writeFileSync(${JSON.stringify(cancelled)},'done');
      });
      installStopControls([{dir:${JSON.stringify(dir)},what:'fixture',nonce:'generation'}]);
      void (async()=>{
        await new Promise(resolve=>registerSignalHandler(()=>resolve()));
        await finishDriverPassRegistrations([]);
        writeFileSync(${JSON.stringify(mutation)},'advanced');
      })();
      requestDriverStop(${JSON.stringify(dir)},'generation');
      setInterval(()=>{},1000);
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expectSpawnExit({ exitCode, stdout, stderr }, 143);
      expect(readFileSync(released, "utf8")).toBe("cancelled");
      expect(existsSync(cancelled)).toBe(true);
      expect(existsSync(mutation)).toBe(false);
    } finally {
      if (existsSync(helperPid)) {
        const targets = await captureProcessTree(
          Number(readFileSync(helperPid, "utf8")),
        );
        if (targets?.[0]?.args.includes(helperPid))
          await signalIdentityTargets(targets, "SIGKILL");
      }
      proc.kill();
      await proc.exited;
    }
  }, 60000);

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
      NODE_ENV: "test",
    };
    const driver = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "fixtures", "stop-diagnostics.ts"),
        ...scriptArgv(
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
        ).filter((arg, index) => index !== 0 || arg !== process.execPath),
      ],
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
        {
          exitCode: stopCode,
          stdout: stopOut,
          stderr: `${stopErr}\ndriver exit at operator completion: ${String(driver.exitCode)}\n--- driver log ---\n${readFileSync(join(stateDir, "drive-pr-999.log"), "utf8")}`,
        },
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
