import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import { DEFAULT_LOCK_TIMEOUT, lockEnv, testCommand } from "./test.ts";

const SCRIPT = join(import.meta.dir, "test.ts");

/** This process's environment as a contended run sees it: no CI, no bypass, no lock settings. */
function contended(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CI|RESOURCE_LOCK_BYPASS|LOCK_[A-Z_]+)$/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** Publish `jig-lock.heavy` under `root` the way the reference script does, owned by this live process. */
function holdLock(root: string): void {
  const lock = join(root, "jig-lock.heavy");
  if (process.platform === "win32") writeFileSync(lock, String(process.pid));
  else symlinkSync(String(process.pid), lock);
}

test("the fixed bun test arguments come first and the caller's follow them", () => {
  expect(testCommand(["./website/"], "bun", "linux")).toEqual([
    "bun",
    "test",
    "--timeout",
    "30000",
    "--parallel=4",
    "./website/",
  ]);
  expect(testCommand([], "bun", "linux")).toEqual([
    "bun",
    "test",
    "--timeout",
    "30000",
    "--parallel=4",
  ]);
});

test("Windows runs one worker while preserving the timeout, shard and caller arguments", () => {
  expect(
    testCommand(["--shard=2/4", "./plugin/skills/drive-pr/"], "bun", "win32"),
  ).toEqual([
    "bun",
    "test",
    "--timeout",
    "30000",
    "--parallel=1",
    "--shard=2/4",
    "./plugin/skills/drive-pr/",
  ]);
});

test("the wait defaults to an hour and yields to the caller's LOCK_TIMEOUT", () => {
  expect(lockEnv({}).LOCK_TIMEOUT).toBe(DEFAULT_LOCK_TIMEOUT);
  expect(lockEnv({ LOCK_TIMEOUT: "5" }).LOCK_TIMEOUT).toBe("5");
  expect(lockEnv({ LOCK_TIMEOUT: "" }).LOCK_TIMEOUT).toBe(DEFAULT_LOCK_TIMEOUT);
});

test("one run's cost is the suite's worker count unless the caller sets it", () => {
  expect(lockEnv({}, "linux").LOCK_RUN_COST).toBe("4");
  expect(lockEnv({}, "win32").LOCK_RUN_COST).toBe("1");
  expect(lockEnv({ LOCK_RUN_COST: "2" }, "linux").LOCK_RUN_COST).toBe("2");
});

test("a run says who holds the lock, waits LOCK_TIMEOUT for a live holder and gives up with the lock's status", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-test-lock-"));
  try {
    holdLock(root);
    const result = Bun.spawnSync([process.execPath, SCRIPT], {
      env: contended({ LOCK_ROOT: root, LOCK_TIMEOUT: "0", LOCK_SLOTS: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(result, 3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      `resource lock: waiting for 'heavy' (held by pid ${process.pid}`,
    );
    expect(stderr).toContain("could not acquire lock 'heavy' within 0s");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
