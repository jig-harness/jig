import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
  withoutLeakyGitEnv,
} from "../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "./test-helpers/expect-spawn-exit.ts";
import { normalizePathKey } from "./test-env.ts";

test("a Windows-spelled Path becomes PATH", () => {
  const env: Record<string, string | undefined> = { Path: "C:\\bin", A: "1" };
  normalizePathKey(env);
  expect(env).toEqual({ PATH: "C:\\bin", A: "1" });
});

test("an environment that already says PATH is left as it is", () => {
  const env: Record<string, string | undefined> = { PATH: "/bin", B: "2" };
  normalizePathKey(env);
  expect(env).toEqual({ PATH: "/bin", B: "2" });
});

test("when both spellings are present the explicit PATH wins and Path goes", () => {
  const env: Record<string, string | undefined> = { Path: "old", PATH: "new" };
  normalizePathKey(env);
  expect(env).toEqual({ PATH: "new" });
});

test("an environment without a path is left without one", () => {
  const env: Record<string, string | undefined> = { C: "3" };
  normalizePathKey(env);
  expect(env).toEqual({ C: "3" });
});

test("the preload leaves a spread of the test environment with one path key", () => {
  const keys = Object.keys({ ...process.env }).filter(
    (key) => key.toLowerCase() === "path",
  );
  expect(keys).toEqual(["PATH"]);
});

test("the runner and preload isolate inherited git hook variables", () => {
  const scratch = mkdtempSync(join(tmpdir(), "jig-preload-git-"));
  try {
    const initialized = spawnSync("git", ["init", "-q", scratch], {
      env: withoutLeakyGitEnv(),
    });
    expectSpawnExit({ ...initialized, exitCode: initialized.status }, 0);
    const fixture = join(scratch, "hook-env.test.ts");
    writeFileSync(
      fixture,
      `
      import { expect, test } from "bun:test";
      import { expectSpawnExit } from ${JSON.stringify(join(import.meta.dir, "test-helpers/expect-spawn-exit.ts"))};
      test("git uses the fixture repository", () => {
        const names = ${JSON.stringify(LEAKY_GIT_ENV)};
        expect(Object.keys(process.env).filter(key => names.includes(key.toUpperCase()))).toEqual([]);
        const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"],
          process.env.PROBE_EXPLICIT_ENV === "1" ? { env: { ...process.env } } : {});
        expectSpawnExit(result, 0);
        expect(new TextDecoder().decode(result.stdout).trim().replaceAll("\\\\", "/"))
          .toBe(${JSON.stringify(realpathSync(scratch).replaceAll("\\", "/"))});
      });
    `,
    );
    for (const mixedCase of [false, true]) {
      const hostile = Object.fromEntries(
        LEAKY_GIT_ENV.map((name) => [
          mixedCase ? name.toLowerCase().replace(/^g/, "G") : name,
          join(scratch, "must-not-be-used"),
        ]),
      );
      // The preload cleans JavaScript's environment. Bun's implicit spawn
      // environment retains startup values, so the runner also starts the
      // test process with an explicitly clean environment.
      for (const runner of [false, true]) {
        const command = runner
          ? [process.execPath, join(import.meta.dir, "../scripts/test.ts")]
          : [process.execPath, "test"];
        const result = Bun.spawnSync(
          [
            ...command,
            "--preload",
            join(import.meta.dir, "test-env-preload.ts"),
            fixture,
          ],
          {
            cwd: scratch,
            env: {
              ...withoutLeakyGitEnv(),
              ...hostile,
              CI: "1",
              PROBE_EXPLICIT_ENV: runner ? "0" : "1",
            },
            timeout: 30_000,
          },
        );
        expectSpawnExit(
          result,
          0,
          mixedCase ? "mixed-case hook variables" : "hook variables",
        );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 130_000);
