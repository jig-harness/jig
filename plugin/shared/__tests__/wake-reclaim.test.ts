/** Stale reclamation remains exclusive when another waiter arrives at unlink. */
import { it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

it("serializes reclaimers before removing a dead waiter's file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-reclaim-"));
  try {
    const source = [
      'import { mock } from "bun:test";',
      'import * as fs from "node:fs";',
      "const dir = " + JSON.stringify(dir) + ";",
      'const path = dir + "/waiter";',
      "const original = { ...fs };",
      "let compete; let second;",
      'mock.module("node:fs", () => ({ ...original, rmSync(file, options) {',
      "if (file === path && compete) { const start = compete; compete = null; second = start(); }",
      "return original.rmSync(file, options);",
      "}}));",
      "const { requestWake, waitAndRun } = await import(" +
        JSON.stringify(resolve(import.meta.dir, "../wake.ts")) +
        ");",
      "const { encodeIdentity, lockIdentity } = await import(" +
        JSON.stringify(resolve(import.meta.dir, "../liveness.ts")) +
        ");",
      "requestWake(dir);",
      'const dead = Bun.spawnSync([process.execPath, "-e", "0"]);',
      "const { expectSpawnExit } = await import(" +
        JSON.stringify(
          resolve(
            import.meta.dir,
            "../../../lib/test-helpers/expect-spawn-exit.ts",
          ),
        ) +
        ");",
      "expectSpawnExit(dead, 0);",
      "original.writeFileSync(path, encodeIdentity(lockIdentity(dead.pid)));",
      "let runs = 0; let release;",
      "const held = new Promise(done => { release = done; });",
      'const clock = { now: () => Date.now(), sleep: async () => { throw new Error("a second waiter reached the spacing sleep"); } };',
      "const deps = { clock, busy: 3, run: async () => { runs++; await held; return { ok: true, value: 0 }; } };",
      "compete = () => waitAndRun(dir, deps);",
      "const first = waitAndRun(dir, deps);",
      'if (runs !== 1) throw new Error("concurrent runs: " + runs);',
      "release();",
      "const results = await Promise.all([first, second]);",
      'if (runs !== 1) throw new Error("concurrent runs: " + runs);',
      'if (!results.some(r => r.end === "elsewhere")) throw new Error(JSON.stringify(results));',
    ].join("\n");
    expectSpawnExit(
      Bun.spawnSync([process.execPath, "-e", source], { timeout: 10_000 }),
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
