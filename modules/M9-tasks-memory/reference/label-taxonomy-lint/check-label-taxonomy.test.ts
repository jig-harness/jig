import { test, expect } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
// Each bad fixture breaks exactly one invariant: it fails with one problem,
// and that problem is the one the fixture is named for.
const cases: [string, number, string][] = [
  ["bad/duplicate-id.yaml", 1, "duplicate label id"],
  ["bad/duplicate-types-key.yaml", 1, "duplicate top-level key"],
  ["bad/empty-statuses.yaml", 1, "'statuses:' is empty"],
  ["bad/flag-duplicate-fires.yaml", 1, "duplicate 'fires:' field"],
  ["bad/flag-empty-list-fires.yaml", 1, "declares no 'fires:'"],
  ["bad/flag-missing-fires.yaml", 1, "declares no 'fires:'"],
  ["bad/flag-missing-scope.yaml", 1, "declares no 'scope:'"],
  ["bad/flag-bad-scope.yaml", 1, "has scope 'anywhere'"],
  ["bad/flag-missing-apply-when.yaml", 1, "declares no 'apply_when:'"],
  ["bad/flag-empty-do-not-apply-when.yaml", 1, "empty 'do_not_apply_when:'"],
  ["bad/flag-requires-unknown.yaml", 1, "requires 'legal'"],
  ["bad/flag-requires-self.yaml", 1, "requires itself"],
  ["bad/unknown-key.yaml", 1, "unknown top-level key"],
  ["good/label-taxonomy.yaml", 0, "OK — labels valid"],
];
for (const [name, code, expected] of cases)
  test(name, () => {
    const run = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "check-label-taxonomy.ts"),
      fixture(name),
    ]);
    const out = run.stdout.toString();
    expectSpawnExit(run, code);
    expect(out).toContain(expected);
    if (code === 1) expect(out).toContain("FAILED: 1 problem(s)");
  });
test("the template passes", () => {
  const run = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "check-label-taxonomy.ts"),
    join(import.meta.dir, "../../templates/label-taxonomy.yaml"),
  ]);
  expectSpawnExit(run, 0);
});
