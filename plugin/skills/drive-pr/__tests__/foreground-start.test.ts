import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  captureProcessTree,
  signalIdentityTargets,
} from "../../../shared/process-tree.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/foreground-wait.ts");

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fgstart-"));
});

const pidOf = (name: string): number | null => {
  const file = join(cwd, ".context", "foreground-wait", "gen-1", name);
  return existsSync(file)
    ? Number.parseInt(readFileSync(file, "utf8"), 10)
    : null;
};

// The runner's whole tree, captured before anything dies, then its state.
afterEach(async () => {
  const runner = pidOf("runner.pid");
  const targets = runner === null ? null : await captureProcessTree(runner);
  if (targets) await signalIdentityTargets(targets, "SIGKILL");
  rmSync(cwd, { recursive: true, force: true });
});

test("launch returns once the runner has started the command, so a cancellation of the runner's tree reaches it", async () => {
  // Every native process-table read takes a while, as on a loaded host: the
  // runner binds itself with one such read after starting up, so it starts
  // the command well after the launcher's own read returned.
  const shim = join(cwd, "slow-table");
  mkdirSync(shim);
  const native = byPlatform(
    "Windows reads CIM through PowerShell; POSIX reads ps",
    { windows: "powershell.exe", posix: "ps" },
  );
  const actual = Bun.which(native);
  expect(actual).not.toBeNull();
  writeFakeProgram(
    join(shim, native),
    `#!/usr/bin/env bun\nawait Bun.sleep(300); const result=Bun.spawnSync([${JSON.stringify(actual)},...process.argv.slice(2)], {stdout:"pipe",stderr:"inherit"}); process.stdout.write(result.stdout); process.exit(result.exitCode);`,
  );
  const launched = Bun.spawnSync(
    [
      process.execPath,
      SCRIPT,
      "launch",
      "--",
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ],
    {
      cwd,
      stderr: "pipe",
      env: { ...process.env, PATH: `${shim}${delimiter}${process.env.PATH}` },
    },
  );
  expectSpawnExit(launched, 0);
  const command = pidOf("cmd.pid");
  expect(command).not.toBeNull();
  const tree = await captureProcessTree(pidOf("runner.pid") as number);
  expect(tree?.some((row) => row.pid === command)).toBe(true);
}, 60_000);
