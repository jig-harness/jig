import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { expectSpawnExitNot } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { cleanEnv, runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Whether config-fit reports dispatch refusing a repository whose labels are `enabled` and whose manual-operations label is `name`. */
function refused(name: string, enabled: boolean): boolean {
  const dir = scratchRepo({
    ".config/jig.yaml": `dispatch:\n  labels:\n    enabled: ${enabled}\nissue_tracker:\n  labels:\n    manual_ops: ${name}\n`,
  });
  dirs.push(dir);
  const run = runScript(
    "config-fit.ts",
    ["--offline", "--json"],
    dir,
    cleanEnv(),
  );
  expectSpawnExitNot(
    { exitCode: run.code, stdout: run.out, stderr: run.err },
    2,
    "config-fit",
  );
  const { findings } = JSON.parse(run.out) as { findings: { id: string }[] };
  return findings.some((f) => f.id === "invalid:manual-ops-label");
}

test("a manual_ops label the forge cannot take is refused where dispatch labels are on", () => {
  expect(refused("x".repeat(51), true)).toBe(true);
  expect(refused("ops-step", true)).toBe(false);
});

test("it is not checked where dispatch labels are off", () => {
  expect(refused("x".repeat(51), false)).toBe(false);
});
