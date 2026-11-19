import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  readResourceLockSamples,
  recordResourceLockSample,
} from "../resource-lock-samples.ts";
import { isoFromMs, parseMs } from "../time.ts";

const LOCK = resolve(import.meta.dir, "../resource-lock.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "jig-lock-samples-")));
  dirs.push(home);
  const lockRoot = join(home, "locks");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const { CI: _ci, RESOURCE_LOCK_BYPASS: _bypass, ...env } = process.env;
  const samples = join(home, ".local", "state", "jig", "resource-lock-samples");
  return {
    workspace,
    samples,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      LOCK_ROOT: lockRoot,
      LOCK_NAME: "heavy",
      LOCK_SLOTS: "1",
    },
  };
}

function runLock(scratch: ReturnType<typeof fixture>, ...args: string[]) {
  const program = `const { main } = await import(${JSON.stringify(LOCK)}); process.exitCode = await main(${JSON.stringify(args)});`;
  return Bun.spawnSync([process.execPath, "-e", program], {
    cwd: scratch.workspace,
    env: scratch.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a completed lock run leaves one sample with its request, wait, hold and workspace", () => {
  const scratch = fixture();
  const child = runLock(
    scratch,
    "--",
    process.execPath,
    "-e",
    "process.exitCode = 7;",
  );
  expectSpawnExit(child, 7);
  const entries = readdirSync(scratch.samples);
  expect(entries).toHaveLength(1);
  const [sample] = readResourceLockSamples("heavy", undefined, scratch.env);
  expect(sample).toMatchObject({
    name: "heavy",
    workspace: scratch.workspace,
    waitMs: 0,
  });
  expect(Number.isFinite(parseMs(sample?.requestedAt ?? ""))).toBe(true);
  expect(sample?.holdMs).toBeGreaterThan(0);
});

test("a failed telemetry write preserves the command's exit", () => {
  const scratch = fixture();
  mkdirSync(resolve(scratch.samples, ".."), { recursive: true });
  writeFileSync(scratch.samples, "not a directory");
  expectSpawnExit(
    runLock(scratch, "--", process.execPath, "-e", "process.exitCode = 9;"),
    9,
  );
});

test("the reader excludes other locks, records past the retention window, and malformed records", () => {
  const scratch = fixture();
  const now = 1_800_000_000_000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const write = (name: string, released: number) => {
    recordResourceLockSample(
      {
        name,
        workspace: scratch.workspace,
        requestedAt: isoFromMs(released - 1_500),
        waitMs: 500,
        holdMs: 1000,
      },
      released,
      scratch.env,
    );
  };
  write("heavy", now - week - 1);
  const expired = readdirSync(scratch.samples);
  expect(expired).toHaveLength(1);
  expect(readResourceLockSamples("heavy", now, scratch.env)).toEqual([]);
  write("web", now - 1);
  write("heavy", now);
  writeFileSync(
    join(scratch.samples, `${now}-${crypto.randomUUID()}.json`),
    "bad JSON",
  );
  expect(
    expired.some((entry) => existsSync(join(scratch.samples, entry))),
  ).toBe(false);
  const samples = readResourceLockSamples("heavy", now, scratch.env);
  expect(samples).toEqual([
    {
      name: "heavy",
      workspace: scratch.workspace,
      requestedAt: isoFromMs(now - 1_500),
      waitMs: 500,
      holdMs: 1000,
    },
  ]);
});
