import { test, expect } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const gate = join(import.meta.dir, "check-events.ts"),
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
  ["good/events.log", 0, {}],
  ["empty.log", 0, {}],
  ["bad/unknown-type.log", 1, {}],
  ["bad/missing-required.log", 1, {}],
  ["bad/empty-required.log", 1, {}],
  ["bad/malformed-token.log", 2, {}],
  ["bad/no-type.log", 2, {}],
  ["bad/does-not-exist.log", 2, {}],
];
for (const [file, code, env] of cases)
  test(file, () => expectSpawnExit(run([join(fix, file)], env), code));
test("missing input file fails closed", () =>
  expectSpawnExit(run([join(fix, "absent-file")]), 2));
for (const file of [
  "schema-no-required.yaml",
  "schema-no-types.yaml",
  "schema-duplicate-type.yaml",
  "schema-duplicate-required.yaml",
])
  test(file, () =>
    expectSpawnExit(
      run([join(fix, "good/events.log")], { SCHEMA: join(fix, "bad", file) }),
      2,
    ),
  );
test("report identifies offending event and field", () => {
  expect(run([join(fix, "bad/unknown-type.log")]).stdout.toString()).toContain(
    "unregistered event type 'gate_reslt'",
  );
  expect(
    run([join(fix, "bad/missing-required.log")]).stdout.toString(),
  ).toContain("missing required field 'outcome'");
});
