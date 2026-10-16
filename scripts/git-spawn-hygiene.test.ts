import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

const root = resolve(import.meta.dir, "..");
const safeEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);

// Exercise the complete suites: their Bun/script subprocesses also run git,
// so isolating only the explicit `git init` calls would not protect the index.
test("scratch suites preserve a sentinel repository under hook-style env", () => {
  const sentinel = mkdtempSync(join(tmpdir(), "jig-git-sentinel-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", sentinel, ...args], {
      env: safeEnv,
    });
    expectSpawnExit({ ...result, exitCode: result.status }, 0);
    return result.stdout;
  };
  try {
    git("init", "-q");
    git("config", "core.bare", "false");
    writeFileSync(
      join(sentinel, "sentinel.txt"),
      "Keep this index untouched.\n",
    );
    git("add", "sentinel.txt");
    const config = readFileSync(join(sentinel, ".git/config"));
    const index = readFileSync(join(sentinel, ".git/index"));
    const leaks = {
      GIT_DIR: join(sentinel, ".git"),
      GIT_WORK_TREE: sentinel,
      GIT_INDEX_FILE: join(sentinel, ".git/index"),
      Git_Dir: join(sentinel, ".git"),
    };
    // The guarded outer launch starts clean. This deliberately hostile harness
    // injects hook variables only into the suites whose isolation is tested.
    const harness = `
      const result = Bun.spawnSync(
        [process.execPath, "test", "scripts/freshness.test.ts", "scripts/gates.test.ts"],
        { cwd: ${JSON.stringify(root)}, env: { ...process.env, ...${JSON.stringify(leaks)} } },
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    `;
    const result = spawnSync(process.execPath, ["-e", harness], {
      cwd: root,
      env: { ...safeEnv, JIG_BASH_PARITY: "0" },
      timeout: 30_000,
    });
    expectSpawnExit(
      { ...result, exitCode: result.status },
      0,
      "hook-env suites",
    );
    expect(readFileSync(join(sentinel, ".git/config"))).toEqual(config);
    expect(readFileSync(join(sentinel, ".git/index"))).toEqual(index);
    expect(git("ls-files")).toBe("sentinel.txt\n");
    expect(git("status", "--porcelain")).toBe("A  sentinel.txt\n");
  } finally {
    rmSync(sentinel, { recursive: true, force: true });
  }
}, 40_000);
