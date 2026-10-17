import { test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["bad/closed-missing-required.txt", 1, "token"],
  ["bad/closed-quoted-missing.txt", 1, "token"],
  ["bad/duplicate-status.txt", 2, "token"],
  ["bad/no-status.txt", 2, "token"],
  ["good/closed-complete.txt", 0, "token"],
  ["good/open-incomplete.txt", 0, "token"],
  ["good/shipped-incomplete.txt", 0, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    env.FORMULA = fixture("formula.yaml");
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "check-formula.ts"), ...args],
      { env: { ...process.env, ...env } },
    );
    expectSpawnExit(run, code);
  });
