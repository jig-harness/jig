import { test, expect } from "bun:test";
import { join } from "node:path";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["bad-row.tsv", 2, "token"],
  ["clean.tsv", 0, "token"],
  ["duplicate-reviewer.tsv", 2, "token"],
  ["empty.tsv", 0, "token"],
  ["extra-column.tsv", 2, "token"],
  ["missed.tsv", 1, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "check-parity.ts"), ...args],
      { env: { ...process.env, ...env } },
    );
    expect(run.exitCode).toBe(code);
  });
