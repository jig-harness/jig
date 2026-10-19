import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { createProcessRegistry } from "../../../shared/process-registry.ts";
import { processTable } from "../../../shared/process-table.ts";
import {
  captureProcessTree,
  signalIdentityTargets,
  stopWindowsTree,
} from "../../../shared/process-tree.ts";

test("pass cancellation consumes the registry and stops a runner reparented after launch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "registered-pass-"));
  const registry = createProcessRegistry();
  const pass = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {},1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const script = resolve(import.meta.dir, "../scripts/foreground-wait.ts");
  let runner: number | undefined;
  try {
    const launched = Bun.spawnSync(
      [
        process.execPath,
        script,
        "launch",
        "--",
        process.execPath,
        "-e",
        "Bun.spawn([process.execPath,'-e','setInterval(() => {},1000)'],{stdout:'ignore',stderr:'ignore'});setInterval(() => {},1000)",
      ],
      {
        cwd,
        env: { ...process.env, JIG_PROCESS_REGISTRY_DIR: registry.dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(launched, 0);
    const generation = readdirSync(
      join(cwd, ".context", "foreground-wait"),
    ).find((name) => name.startsWith("gen-"));
    if (!generation) throw new Error("launcher did not publish its generation");
    const generationDir = join(cwd, ".context", "foreground-wait", generation);
    runner = Number(readFileSync(join(generationDir, "runner.pid"), "utf8"));
    const deadline = Date.now() + 15_000;
    let tree = await captureProcessTree(runner);
    while ((tree?.length ?? 0) < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      tree = await captureProcessTree(runner);
    }
    expect(tree?.length).toBeGreaterThanOrEqual(3);
    const snapshot = await processTable();
    expect(snapshot?.find((row) => row.pid === runner)?.ppid).not.toBe(
      pass.pid,
    );
    // The pass's ordinary descendant walk cannot see this runner anymore.
    expect(
      (await captureProcessTree(pass.pid))?.some((row) => row.pid === runner),
    ).toBe(false);
    expect(await stopWindowsTree(pass.pid, 20, registry.dir)).toBe(true);
    const after = await processTable();
    expect(after).not.toBeNull();
    for (const target of tree ?? []) {
      expect(
        after?.some(
          (row) =>
            row.pid === target.pid &&
            row.start === target.start &&
            !row.stat.startsWith("Z"),
        ),
      ).toBe(false);
    }
    await pass.exited;
  } finally {
    if (runner !== undefined) {
      const tree = await captureProcessTree(runner);
      if (tree) await signalIdentityTargets(tree, "SIGKILL");
    }
    pass.kill();
    await pass.exited;
    registry.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
