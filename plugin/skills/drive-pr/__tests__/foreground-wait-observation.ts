import { expect } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { captureProcessTree } from "../../../shared/process-tree.ts";

const sleepMs = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an observable fixture boundary instead of assuming process scheduling. */
export async function awaitObserved(
  description: string,
  observed: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await observed()) && Date.now() < deadline) await sleepMs(20);
  expect(await observed(), description).toBe(true);
}

export async function capturedCommand(marker: string, pids: number[]) {
  const deadline = Date.now() + 20_000;
  let complete = false;
  let captured: { pid: number; start: string }[] = [];
  while (!complete && Date.now() < deadline) {
    try {
      const capture = JSON.parse(readFileSync(marker, "utf8")) as {
        targets: { pid: number; start: string }[];
      };
      captured = capture.targets;
      complete = pids.every((pid) =>
        capture.targets.some((target) => target.pid === pid),
      );
    } catch {
      // The tracker has not published a complete acknowledgment yet.
    }
    if (!complete) await sleepMs(20);
  }
  expect(complete).toBe(true);
  return captured;
}

export async function capturedRunner(runner: number, pids: number[]) {
  const deadline = Date.now() + 20_000;
  let targets = await captureProcessTree(runner);
  while (
    !pids.every((pid) => targets?.some((target) => target.pid === pid)) &&
    Date.now() < deadline
  ) {
    await sleepMs(20);
    targets = await captureProcessTree(runner);
  }
  for (const pid of pids)
    expect(targets?.some((target) => target.pid === pid)).toBe(true);
  return targets ?? [];
}

/** Process-enumerator fixture with observable failure and recovery boundaries. */
export function installSnapshotFailureFixture(cwd: string) {
  const shim = join(cwd, "shim");
  mkdirSync(shim);
  const flag = join(cwd, "psbroken");
  const broken = join(cwd, "snapshot-broken");
  const restored = join(cwd, "snapshot-restored");
  const nativeFailure = join(cwd, "snapshot-native-failure");
  const deadlineGate = join(cwd, "start-deadline");
  const captured = join(cwd, "capture.json");
  const native = byPlatform(
    "Windows reads CIM through PowerShell; POSIX reads ps",
    { windows: "powershell.exe", posix: "ps" },
  );
  const actual = Bun.which(native);
  expect(actual).not.toBeNull();
  writeFakeProgram(
    join(shim, native),
    `#!/usr/bin/env bun\nconst fs=require("node:fs");if(fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(broken)},"");process.exit(1)}if(fs.existsSync(${JSON.stringify(nativeFailure)}))process.exit(1);const recovering=fs.existsSync(${JSON.stringify(broken)});const result=Bun.spawnSync([${JSON.stringify(actual)},...process.argv.slice(2)], {stdout:"pipe",stderr:"inherit"});process.stdout.write(result.stdout);if(recovering&&result.exitCode===0)fs.writeFileSync(${JSON.stringify(restored)},"");process.exit(result.exitCode);`,
  );
  return {
    broken,
    captured,
    deadlineGate,
    flag,
    nativeFailure,
    restored,
    path: `${shim}${delimiter}${process.env.PATH}`,
  };
}
