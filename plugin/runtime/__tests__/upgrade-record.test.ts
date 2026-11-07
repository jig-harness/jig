/**
 * The scheduled upgrade's record: the user file's `upgrade` setting as the
 * run, `jig doctor` and `jig install --no-upgrade` read it, the line a
 * receipt shows, and the value the launcher passes a job.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  everyMs,
  SCHEDULED_UPGRADE_ENV,
  takeScheduledUpgrade,
  upgradeLine,
  upgradeSettings,
} from "../upgrade-record.ts";

/** An environment whose user file holds `text`. */
function withUserFile(text: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "upgrade-record-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "jig.yaml"), text);
  return { JIG_HOME: home };
}

test("with no setting the timers upgrade every hour", () => {
  expect(upgradeSettings(withUserFile(""))).toMatchObject({
    enabled: true,
    every: "1h",
    everyMs: 3_600_000,
  });
});

test.each([
  ["upgrade: off\n"],
  ["upgrade: false\n"],
  ["upgrade:\n  enabled: false\n"],
])("%s opts the machine out", (text) => {
  expect(upgradeSettings(withUserFile(text)).enabled).toBe(false);
});

test("every takes minutes, hours or days", () => {
  expect(
    upgradeSettings(withUserFile("upgrade:\n  every: 30m\n")),
  ).toMatchObject({ enabled: true, everyMs: 1_800_000 });
  expect(everyMs("2d")).toBe(172_800_000);
  for (const wrong of ["0h", "1w", "1.5h", "h", "90"])
    expect(everyMs(wrong)).toBeNull();
});

test.each([
  ["upgrade:\n  every: 1w\n", "upgrade.every must be"],
  ["upgrade:\n  enabled: maybe\n", "upgrade.enabled must be true or false"],
  ["upgrade:\n  interval: 1h\n", "upgrade has no field interval"],
  ["upgrade: [1h]\n", "upgrade must be off, or a mapping"],
])("%s is refused, naming the file", (text, message) => {
  const env = withUserFile(text);
  expect(() => upgradeSettings(env)).toThrow(message);
  expect(() => upgradeSettings(env)).toThrow(
    join(env.JIG_HOME as string, "jig.yaml"),
  );
});

test("a receipt's line is the move for an update, else the outcome and why", () => {
  expect(
    upgradeLine({
      outcome: "updated",
      detail: "claude 0.114.0 -> 0.115.0",
      at: "2026-11-07T04:00:00.000Z",
      from: "0.114.0",
      to: "0.115.0",
    }),
  ).toBe("0.114.0 -> 0.115.0");
  expect(
    upgradeLine({
      outcome: "failed",
      detail: "network down",
      at: "2026-11-07T04:00:00.000Z",
    }),
  ).toBe("failed: network down");
});

test("a job takes the launcher's upgrade out of its environment, and ignores one that does not read", () => {
  const upgrade = {
    outcome: "skipped",
    detail: "in place",
    at: "2026-11-07T04:00:00.000Z",
  };
  const env: NodeJS.ProcessEnv = {
    [SCHEDULED_UPGRADE_ENV]: JSON.stringify(upgrade),
  };
  expect(takeScheduledUpgrade(env)).toEqual(upgrade as never);
  expect(env[SCHEDULED_UPGRADE_ENV]).toBeUndefined();
  expect(
    takeScheduledUpgrade({ [SCHEDULED_UPGRADE_ENV]: '{"outcome":"done"}' }),
  ).toBeUndefined();
  expect(
    takeScheduledUpgrade({ [SCHEDULED_UPGRADE_ENV]: "not json" }),
  ).toBeUndefined();
});
