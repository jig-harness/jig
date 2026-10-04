import { test, expect } from "bun:test";
import { join } from "node:path";
const gate = join(import.meta.dir, "check-metrics-wired.ts"),
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
  ["good/metrics-registry.yaml", 0, {}],
  ["good/commented-header.yaml", 0, {}],
  ["empty-registry.yaml", 0, {}],
  ["bad/todo-source.yaml", 1, {}],
  ["bad/empty-source.yaml", 1, {}],
  ["bad/missing-source.yaml", 1, {}],
  ["bad/placeholder-variants.yaml", 1, {}],
  ["bad/empty-list-source.yaml", 1, {}],
  ["bad/commented-header-todo-source.yaml", 1, {}],
  ["bad/no-metrics-key.yaml", 2, {}],
  ["bad/scalar-metrics.yaml", 2, {}],
  ["bad/mapping-metrics.yaml", 2, {}],
  ["bad/stray-after-item.yaml", 2, {}],
  ["bad/nested-source-overrides.yaml", 1, {}],
  ["bad/nested-keys-override.yaml", 1, {}],
  ["good/nested-fields-ignored.yaml", 0, {}],
  ["good/comment-on-marker.yaml", 0, {}],
  ["good/nested-list.yaml", 0, {}],
  ["bad/does-not-exist.yaml", 2, {}],
];
for (const [file, code, env] of cases)
  test(file, () => expect(run([join(fix, file)], env).exitCode).toBe(code));
test("missing input file fails closed", () =>
  expect(run([join(fix, "absent-file")]).exitCode).toBe(2));
test("report names dark metrics and keeps the wired source", () => {
  expect(run([join(fix, "bad/todo-source.yaml")]).stdout.toString()).toContain(
    "DARK review-adoption-rate",
  );
  const report = run([
    join(fix, "bad/placeholder-variants.yaml"),
  ]).stdout.toString();
  expect(report).toContain("DARK metric-b");
  expect(report).toContain("OK   metric-e");
});
test("non-list content under metrics: is a format error, not an empty registry", () => {
  const result = run([join(fix, "bad/mapping-metrics.yaml")]);
  expect(result.stderr.toString()).toContain("must hold a block list");
  expect(result.stdout.toString()).not.toContain("empty registry");
});
test("a nested list inside an item is not counted as another metric", () =>
  expect(run([join(fix, "good/nested-list.yaml")]).stdout.toString()).toContain(
    "all 1 metric(s)",
  ));
test("nested id/source keys neither replace identity nor source", () => {
  const dark = run([
    join(fix, "bad/nested-keys-override.yaml"),
  ]).stdout.toString();
  expect(dark).toContain("DARK adoption");
  expect(dark).not.toContain("other");
  const ok = run([
    join(fix, "good/nested-fields-ignored.yaml"),
  ]).stdout.toString();
  expect(ok).toContain("OK   adoption — source: event:adoption");
});
