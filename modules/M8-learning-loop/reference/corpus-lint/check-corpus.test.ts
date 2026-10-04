import { test, expect } from "bun:test";
import { join } from "node:path";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["bad/duplicate-lever.yaml", 1, "token"],
  ["bad/empty-pin-lens.yaml", 1, "token"],
  ["bad/fake-validated.yaml", 1, "token"],
  ["bad/inline-comment-required.yaml", 1, "token"],
  ["bad/malformed-lever.yaml", 1, "token"],
  ["bad/missing-pin.yaml", 1, "token"],
  ["bad/no-fixtures-key.yaml", 2, "token"],
  ["bad/no-lever.yaml", 1, "token"],
  ["bad/quoted-fixtures.yaml", 1, "token"],
  ["bad/quoted-required.yaml", 1, "token"],
  ["bad/unknown-category.yaml", 1, "token"],
  ["bad/unparseable-required.yaml", 1, "token"],
  ["bad/unvalidated-required.yaml", 1, "token"],
  ["bad/uppercase-required.yaml", 1, "token"],
  ["good/corpus.yaml", 0, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    env.TAXONOMY = fixture("miss-taxonomy.yaml");
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "check-corpus.ts"), ...args],
      { env: { ...process.env, ...env } },
    );
    expect(run.exitCode).toBe(code);
  });
