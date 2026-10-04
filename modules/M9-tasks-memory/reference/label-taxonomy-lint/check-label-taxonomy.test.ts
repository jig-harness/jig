import { test, expect } from "bun:test";
import { join } from "node:path";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["bad/duplicate-id.yaml", 1, "token"],
  ["bad/duplicate-types-key.yaml", 1, "token"],
  ["bad/empty-statuses.yaml", 1, "token"],
  ["bad/flag-duplicate-fires.yaml", 1, "token"],
  ["bad/flag-empty-list-fires.yaml", 1, "token"],
  ["bad/flag-missing-fires.yaml", 1, "token"],
  ["bad/unknown-key.yaml", 1, "token"],
  ["good/label-taxonomy.yaml", 0, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-label-taxonomy.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expect(run.exitCode).toBe(code);
  });
