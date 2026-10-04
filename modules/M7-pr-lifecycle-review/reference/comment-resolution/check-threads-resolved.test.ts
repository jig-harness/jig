import { test, expect } from "bun:test";
import { join } from "node:path";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["bad-ref-deferred.txt", 1, "token"],
  ["bad-ref-hexword.txt", 1, "token"],
  ["bad-ref-moot.txt", 1, "token"],
  ["clean.txt", 0, "token"],
  ["empty.txt", 0, "token"],
  ["no-fix-ref.txt", 1, "token"],
  ["no-reason-moot.txt", 1, "token"],
  ["no-reason.txt", 1, "token"],
  ["open.txt", 1, "token"],
  ["unclassified.txt", 1, "token"],
  ["unknown.txt", 1, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-threads-resolved.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expect(run.exitCode).toBe(code);
  });
