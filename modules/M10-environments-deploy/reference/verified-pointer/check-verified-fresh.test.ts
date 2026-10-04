import { test, expect } from "bun:test";
import { join } from "node:path";
const gate = join(import.meta.dir, "check-verified-fresh.ts"),
  fix = join(import.meta.dir, "fixtures");
function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, gate, ...args], {
    env: {
      ...process.env,
      BEHIND: "",
      AGE_SECONDS: "",
      MAX_BEHIND: "",
      MAX_AGE_SECONDS: "",
      SCHEMA: join(fix, "schema.yaml"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}
const cases: [string, number, Record<string, string>][] = [
  ["fresh.txt", 0, {}],
  ["boundary.txt", 0, {}],
  ["stalled-behind.txt", 1, {}],
  ["stalled-age.txt", 1, {}],
  ["bad-value.txt", 2, {}],
  ["unknown-key.txt", 2, {}],
  ["duplicate-key.txt", 2, {}],
  ["huge-value.txt", 2, {}],
  ["empty.txt", 2, {}],
  ["does-not-exist.txt", 2, {}],
];
for (const [file, code, env] of cases)
  test(file, () => expect(run([join(fix, file)], env).exitCode).toBe(code));
test("missing input file fails closed", () =>
  expect(run([join(fix, "absent-file")]).exitCode).toBe(2));
for (const [code, env] of [
  [0, { BEHIND: "3", AGE_SECONDS: "3600" }],
  [0, { BEHIND: "5" }],
  [1, { BEHIND: "999" }],
  [1, { AGE_SECONDS: "999999" }],
  [2, {}],
  [2, { MAX_BEHIND: "-1", BEHIND: "1" }],
  [2, { MAX_BEHIND: "lots", BEHIND: "1" }],
  [2, { MAX_AGE_SECONDS: "-5", AGE_SECONDS: "1" }],
  [0, { MAX_BEHIND: "100", BEHIND: "50" }],
  [1, { MAX_BEHIND: "2", BEHIND: "3" }],
] as [number, Record<string, string>][])
  test(`environment ${JSON.stringify(env)}`, () =>
    expect(run([], env).exitCode).toBe(code));
test("message surface names freshness or page/heal action", () => {
  expect(run([], { BEHIND: "999" }).stdout.toString()).toContain(
    "page on-call / trigger a heal run",
  );
  expect(run([], { BEHIND: "1" }).stdout.toString()).toContain("fresh");
});
