import { test, expect } from "bun:test";
import { join } from "node:path";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["safe/base-checkout-review.yml", 0, "token"],
  ["safe/labeler-data-only.yml", 0, "token"],
  ["safe/plain-pull-request.yml", 0, "token"],
  ["unsafe/folded-ref-run.yml", 1, "token"],
  ["unsafe/fork-repo-run.yml", 1, "token"],
  ["unsafe/head-sha-run.yml", 1, "token"],
  ["unsafe/local-action-run.yml", 1, "token"],
  ["unsafe/quoted-run.yml", 1, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-pr-target-safety.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expect(run.exitCode).toBe(code);
  });
