/**
 * drive-pr's process layer (`scripts/lib/proc.ts`) is built on the plugin's
 * shared one, not a copy of it: the timeout reader is the same function, and
 * loading both modules in one process installs one cancellation forwarder per
 * signal, with one registry of process groups behind it.
 */
import { expect, it } from "bun:test";
import { join } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { processTable } from "../../../shared/process-table.ts";
import { signalIdentityTargets } from "../../../shared/process-tree.ts";
import {
  expectSpawnExited,
  expectSpawnExit,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import * as review from "../../../shared/proc.ts";
import * as drive from "../scripts/lib/proc.ts";

it("re-exports the shared timeout reader rather than a copy", () => {
  expect(drive.readTimeoutEnv).toBe(review.readTimeoutEnv);
});

it("one forwarder per cancellation signal with both modules loaded", () => {
  const driveProc = join(import.meta.dir, "..", "scripts", "lib", "proc.ts");
  const reviewProc = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "shared",
    "proc.ts",
  );
  const r = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(driveProc)});
await import(${JSON.stringify(reviewProc)});
console.log(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s)).join(","));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(r, 0);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString().trim()).toBe("1,1,1");
});

it("a deadlined child is cancelled through the shared registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proc-parity-"));
  const childFile = join(dir, "child.pid");
  const cancelFile = join(dir, "cancel");
  const driveProc = join(import.meta.dir, "..", "scripts", "lib", "proc.ts");
  const childSource = `const fs=require("node:fs"); const file=${JSON.stringify(childFile)}; fs.writeFileSync(file+".tmp", String(process.pid)); fs.renameSync(file+".tmp", file); setInterval(() => {}, 1000);`;
  const parent = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { run } = await import(${JSON.stringify(driveProc)});
const { existsSync } = await import("node:fs");
const p = run([process.execPath, "-e", ${JSON.stringify(childSource)}], { timeoutSec: 60 });
const control = setInterval(() => {
  if (existsSync(${JSON.stringify(cancelFile)})) {
    clearInterval(control);
    process.emit("SIGINT");
  }
}, 20);
await p;`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let parentExited = false;
  void parent.exited.then(() => {
    parentExited = true;
  });
  let identity: { pid: number; start: string } | undefined;
  const poll = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (!(await condition()) && Date.now() < deadline) await Bun.sleep(20);
    expect(await condition()).toBe(true);
  };
  try {
    // The child publishes readiness itself, so cancellation cannot precede
    // its spawn or depend on a fixed scheduling delay.
    await poll(() => existsSync(childFile));
    const pid = Number(readFileSync(childFile, "utf8"));
    identity = (await processTable())?.find((row) => row.pid === pid);
    expect(identity?.start).toBeTruthy();
    writeFileSync(cancelFile, "");
    // A modeled signal runs the cleanup callbacks on Windows, where killing
    // the parent externally would bypass them through TerminateProcess.
    await poll(() => parentExited);
    await expectSpawnExited(parent, 130);
    await poll(async () => {
      const rows = await processTable();
      return (
        rows !== null &&
        !rows.some(
          (row) =>
            row.pid === pid &&
            row.start === identity?.start &&
            !row.stat.startsWith("Z"),
        )
      );
    });
  } finally {
    if (identity) await signalIdentityTargets([identity], "SIGKILL");
    parent.kill("SIGKILL");
    await parent.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it("uses the shared command-line boundary, so a shared refusal keeps its exit code", async () => {
  const sharedCli = await import("../../../shared/cli.ts");
  const driveCli = await import("../scripts/lib/cli.ts");
  expect(driveCli.ExitError).toBe(sharedCli.ExitError);
  expect(driveCli.runMain).toBe(sharedCli.runMain);
  expect(driveCli.fail).toBe(sharedCli.fail);
});
