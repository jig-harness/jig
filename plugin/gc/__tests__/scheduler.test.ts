import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";

const scheduler = resolve(import.meta.dir, "../scheduler.ts");

interface Markers {
  enabled: string;
  active: string;
  failDisable: string;
}
function fakeSystemctl(paths: Markers & { log: string }): string {
  const { enabled, active, failDisable, log } = paths;
  return `#!/usr/bin/env bun
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (process.env.BUS_DOWN && args[1].startsWith("is-")) { console.error("Failed to connect to bus"); process.exit(1); }
if (args[1] === "is-enabled") { const on = existsSync(${JSON.stringify(enabled)}); console.log(on ? "enabled" : "disabled"); process.exit(on ? 0 : 1); }
if (args[1] === "is-active") { const on = existsSync(${JSON.stringify(active)}); console.log(on ? "active" : "inactive"); process.exit(on ? 0 : 3); }
if (args[1] === "disable") {
  if (existsSync(${JSON.stringify(failDisable)})) { console.error("Failed to stop jig-gc.timer"); process.exit(1); }
  rmSync(${JSON.stringify(enabled)}, { force: true });
  if (args.includes("--now")) rmSync(${JSON.stringify(active)}, { force: true });
}
if (args[1] === "enable") {
  writeFileSync(${JSON.stringify(enabled)}, "");
  if (args.includes("--now")) writeFileSync(${JSON.stringify(active)}, "");
}
if (args[1] === "start") writeFileSync(${JSON.stringify(active)}, "");
`;
}
function driverSource(paths: Markers & { units: string }): string {
  const { units, enabled, active, failDisable } = paths;
  return `import { writeFileSync } from "node:fs";
import { restoreScheduler, snapshotScheduler } from ${JSON.stringify(scheduler)};
const snapshot = await snapshotScheduler("systemd");
writeFileSync(${JSON.stringify(join(units, "jig-gc.timer"))}, "replacement timer\\n");
writeFileSync(${JSON.stringify(enabled)}, "");
writeFileSync(${JSON.stringify(active)}, "");
if (process.env.FAIL_DISABLE) writeFileSync(${JSON.stringify(failDisable)}, "");
try {
  await restoreScheduler(snapshot);
  console.log("restored");
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
`;
}

/**
 * A systemd user manager whose timer's enablement and activity are two
 * independent markers, as `systemctl` keeps them. `failDisable` makes
 * `disable` fail the way a stop that cannot complete does.
 */
function systemdFixture(state: { enabled: boolean; active: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "gc-scheduler-"));
  const home = join(root, "home");
  const units = join(home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const enabled = join(root, "enabled"),
    active = join(root, "active"),
    failDisable = join(root, "fail-disable"),
    log = join(root, "calls.log");
  writeFakeProgram(
    join(bin, "systemctl"),
    fakeSystemctl({ enabled, active, failDisable, log }),
  );
  writeFileSync(join(units, "jig-gc.service"), "previous service\n");
  writeFileSync(join(units, "jig-gc.timer"), "previous timer\n");
  if (state.enabled) writeFileSync(enabled, "");
  if (state.active) writeFileSync(active, "");
  // Snapshot, then stand in for an install that replaced and started the
  // job, then restore: the child prints whether restoration succeeded.
  const driver = join(root, "driver.ts");
  writeFileSync(driver, driverSource({ units, enabled, active, failDisable }));
  const restore = (env: Record<string, string> = {}) =>
    Bun.spawnSync([process.execPath, driver], {
      env: {
        ...process.env,
        HOME: home,
        // homedir() reads USERPROFILE on Windows.
        USERPROFILE: home,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    });
  return { units, enabled, active, log, restore };
}

test("restoring an enabled but stopped timer leaves it stopped", () => {
  const f = systemdFixture({ enabled: true, active: false });
  expectSpawnExit(f.restore(), 0);
  expect(existsSync(f.enabled)).toBe(true);
  expect(existsSync(f.active)).toBe(false);
  expect(readFileSync(join(f.units, "jig-gc.timer"), "utf8")).toBe(
    "previous timer\n",
  );
});

test("restoring a disabled but running timer leaves it running", () => {
  const f = systemdFixture({ enabled: false, active: true });
  expectSpawnExit(f.restore(), 0);
  expect(existsSync(f.enabled)).toBe(false);
  expect(existsSync(f.active)).toBe(true);
});

test("a replacement timer that cannot be stopped fails the restoration", () => {
  const f = systemdFixture({ enabled: false, active: false });
  const result = f.restore({ FAIL_DISABLE: "1" });
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("Failed to stop jig-gc.timer");
  expect(readFileSync(f.log, "utf8")).not.toContain("daemon-reload");
});

test("a scheduler state that cannot be read stops before anything changes", () => {
  const f = systemdFixture({ enabled: true, active: true });
  const result = f.restore({ BUS_DOWN: "1" });
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain(
    "Cannot establish scheduler state",
  );
  expect(readFileSync(f.log, "utf8")).not.toContain("disable");
});
