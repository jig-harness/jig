import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { type World, world } from "./fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

test("a tick drops Electron host controls before running children", async () => {
  const w = world();
  current = w;
  const entry = join(w.root, "electron-tick.ts");
  writeFileSync(
    entry,
    `import { mock } from "bun:test";
const launches = ${JSON.stringify(resolve(import.meta.dir, "../lib/launches.ts"))};
const real = await import(launches);
const readLaunches = real.readLaunches;
const { run } = await import(${JSON.stringify(resolve(import.meta.dir, "../../shared/proc.ts"))});
mock.module(launches, () => ({ ...real, readLaunches: async () => {
const child = await run([process.execPath, "-e", "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ELECTRON_') || key === 'CHROME_CRASHPAD_PIPE_NAME'))))"], { timeoutSec: 10, stderr: "pipe" });
process.stdout.write(child.stdout);
if (child.code !== 0) process.exit(child.code);
return readLaunches();
} }));
const { runTick } = await import(${JSON.stringify(resolve(import.meta.dir, "../tick.ts"))});
await runTick({ repos: [] });
`,
  );
  const result = await w.dispatch([], entry, {
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_CRASH_REPORTER_EXTRA: "host-state",
    ELECTRON_CRASHPAD_PIPE_NAME: "host-pipe",
    CHROME_CRASHPAD_PIPE_NAME: "chrome-pipe",
    ELECTRON_ENABLE_LOGGING: "1",
  });
  expectSpawnExit(result, 0);
  const probes = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(probes.length).toBeGreaterThan(0);
  for (const env of probes) {
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_CRASH_REPORTER_EXTRA).toBeUndefined();
    expect(env.ELECTRON_CRASHPAD_PIPE_NAME).toBeUndefined();
    expect(env.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined();
    expect(env.ELECTRON_ENABLE_LOGGING).toBe("1");
  }
});
