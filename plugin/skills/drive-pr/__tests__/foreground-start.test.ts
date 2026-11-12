import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
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
  forceIdentityTargetsAndWitness,
  identityTargetsGone,
  signalIdentityTargets,
} from "../../../shared/process-tree.ts";
import { handOffToRunner } from "../scripts/lib/foreground-start.ts";
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

const alive = (child: ReturnType<typeof spawn>) =>
  child.exitCode === null && child.signalCode === null;

// A runner that never reads the cancel request, as one stuck before it binds.
const unanswering = {
  commandStarted: () => false,
  settled: () => false,
  requestCancel: () => undefined,
  result: () => null,
  recordFailure: () => undefined,
  captureRunnerTree: async () => null,
  endCaptured: async () => "unconfirmed" as const,
};

test("a runner that answers the cancel request is not killed, and its witnessed result decides the verdict", async () => {
  const runner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  let cancelled = false;
  try {
    const status = await handOffToRunner(
      runner,
      { registry: undefined, entry: "x" },
      {
        ...unanswering,
        requestCancel: () => {
          cancelled = true;
        },
        settled: () => cancelled,
        result: () =>
          cancelled
            ? { note: "launch cancelled: x", treeWitnessed: true }
            : null,
        captureRunnerTree: async () => {
          throw new Error("an answering runner is never captured");
        },
      },
      0,
      "launched",
    );
    expect(status).toBe(1);
    expect(alive(runner)).toBe(true);
  } finally {
    runner.kill("SIGKILL");
  }
}, 60_000);

test("a launch that cannot capture the runner's tree leaves the runner alive and records the failure unwitnessed", async () => {
  const runner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  const recorded: boolean[] = [];
  try {
    const status = await handOffToRunner(
      runner,
      { registry: undefined, entry: "x" },
      {
        ...unanswering,
        recordFailure: (witnessed) => recorded.push(witnessed),
        captureRunnerTree: async () => null,
        endCaptured: async () => "unconfirmed",
      },
      0,
      "launched",
    );
    expect(status).toBe(1);
    expect(recorded).toEqual([false]);
    expect(alive(runner)).toBe(true);
  } finally {
    runner.kill("SIGKILL");
  }
}, 60_000);

test("a launch that ran out of budget ends a command the runner started but had not published", async () => {
  // The runner has a child and has written no pid file: only the tree finds it.
  const runner = spawn(
    process.execPath,
    [
      "-e",
      "Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)']); setInterval(()=>{},1000)",
    ],
    { stdio: "ignore" },
  );
  let tree: Awaited<ReturnType<typeof captureProcessTree>> = null;
  const recorded: boolean[] = [];
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      tree = await captureProcessTree(runner.pid as number);
      if (tree && tree.length > 1) break;
      await Bun.sleep(50);
    }
    expect(tree?.length).toBeGreaterThan(1);
    const status = await handOffToRunner(
      runner,
      { registry: undefined, entry: "x" },
      {
        ...unanswering,
        recordFailure: (witnessed) => recorded.push(witnessed),
        captureRunnerTree: () => captureProcessTree(runner.pid as number),
        endCaptured: async (captured, pid) =>
          captured.every((row) => row.pid === pid)
            ? "none"
            : (await forceIdentityTargetsAndWitness(captured))
              ? "ended"
              : "unconfirmed",
      },
      0,
      "launched",
    );
    expect(status).toBe(1);
    // Windows cannot freeze the runner, so it stays as the command's
    // supervisor and the failure is recorded unwitnessed.
    const outcome = byPlatform("Windows cannot freeze an unanswering runner", {
      windows: "preserved",
      posix: "ended",
    });
    expect(
      (await identityTargetsGone(tree as NonNullable<typeof tree>))
        ? "ended"
        : "preserved",
    ).toBe(outcome);
    expect(recorded).toEqual([outcome === "ended"]);
  } finally {
    await signalIdentityTargets(
      (await captureProcessTree(runner.pid as number)) ?? [],
      "SIGKILL",
    );
    runner.kill("SIGKILL");
  }
}, 60_000);
