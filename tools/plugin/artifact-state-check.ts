/** Verify artifact subprocesses keep their default SQLite state inside their scratch home. */
import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";

export function checkArtifactStateIsolation(
  scratch: string,
  env: NodeJS.ProcessEnv,
): void {
  // Verify isolation before invoking copied code that can open a default path.
  expect(env.HOME).toBe(join(scratch, "home"));
  expect(env.USERPROFILE).toBe(join(scratch, "home"));
  const path = join(
    scratch,
    "home",
    ".local",
    "state",
    "jig",
    "dispatch",
    "state.sqlite",
  );
  const script = join(scratch, "artifact-state.ts");
  writeFileSync(
    script,
    `import { stateDb, statePath, closeStateDb } from './cache/dispatch/lib/state.ts';
    const expected = ${JSON.stringify(path)};
    if (statePath() !== expected) { console.error('artifact default state escaped the scratch home'); process.exit(9); }
    stateDb(); closeStateDb(); console.log('scratch state created');`,
  );
  const child = spawnSync(process.execPath, ["--no-env-file", script], {
    cwd: scratch,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expectSpawnExit({ ...child, exitCode: child.status }, 0);
  expect(existsSync(path)).toBe(true);
}
