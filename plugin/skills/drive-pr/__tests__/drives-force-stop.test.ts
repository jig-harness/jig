import { expect, test } from "bun:test";
import {
  forceStopDriver,
  registryCompletionTracker,
} from "../scripts/drives.ts";
import { processTable } from "../../../shared/process-table.ts";
import {
  identityTargetsGone,
  captureRegisteredTreeSnapshot,
  type ProcessTreeControl,
  type WindowsTreeState,
} from "../../../shared/process-tree.ts";
import {
  createProcessRegistry,
  beginProcessRegistration,
  publishProcessIdentity,
} from "../../../shared/process-registry.ts";
import { join } from "node:path";

for (const complete of [false, true]) {
  test(`operator fallback kills known registered work with registry complete=${complete}`, async () => {
    const driver = Bun.spawn(
      [
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
        "drive.ts",
        "999",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const runner = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const registry = createProcessRegistry();
    try {
      const rows = await processTable();
      const owner = rows?.find((row) => row.pid === driver.pid);
      const registered = rows?.find((row) => row.pid === runner.pid);
      expect(owner?.start).toBeTruthy();
      expect(registered?.start).toBeTruthy();
      if (!owner || !registered) return;
      const targets = [owner];
      const state: WindowsTreeState = { root: owner, targets };
      publishProcessIdentity(
        registry.dir,
        "known-runner",
        registered,
        join(registry.dir, "runner-result.tmp"),
      );
      if (!complete)
        beginProcessRegistration(
          registry.dir,
          "pending-launch",
          join(registry.dir, "pending-result.tmp"),
        );
      const refresh = async (control: ProcessTreeControl = {}) =>
        (
          await captureRegisteredTreeSnapshot(registry.dir, {
            ...control,
            state,
          })
        ).complete;
      const result = await forceStopDriver(owner, targets, refresh, 0, state);
      expect(result).toBe(complete ? 0 : 1);
      expect(await identityTargetsGone([owner, registered])).toBe(true);
    } finally {
      driver.kill();
      runner.kill();
      await Promise.all([driver.exited, runner.exited]);
      registry.dispose();
    }
  }, 60000);
}

for (const complete of [false, true]) {
  test(`registry disappearance preserves its last completion proof=${complete}`, async () => {
    const registry = createProcessRegistry();
    try {
      if (!complete)
        beginProcessRegistration(
          registry.dir,
          "pending",
          join(registry.dir, "result.tmp"),
        );
      const refresh = registryCompletionTracker(registry.dir, {
        root: null,
        targets: [],
      });
      expect(await refresh()).toBe(complete);
      registry.dispose();
      expect(await refresh()).toBe(complete);
    } finally {
      registry.dispose();
    }
  });
}
