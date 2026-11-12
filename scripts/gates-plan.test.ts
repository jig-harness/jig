import { expect, test } from "bun:test";

test("the gate set runs its cheap stages first and --fast runs only those", async () => {
  const { plan, CHECKS, heavyStages, testStage } = await import("./gates.ts");
  const test = testStage(["suite/**"], () => []);
  const full = plan(false, test).map((stage) => stage.name);
  const fast = plan(true, test).map((stage) => stage.name);
  // The pre-push hook's fast set: the context budget, format, lint, types
  // and the toolchain pins, then every repository check, and nothing that
  // takes minutes.
  expect(fast).toEqual([
    "bun scripts/check-context-budget.ts",
    "bun run format:check",
    "bun run lint",
    "bun run typecheck",
    "bun run pins",
    ...CHECKS.map((stage) => stage.name),
  ]);
  // The full set is the fast set followed by the heavy stages, so every
  // repository check reports before the first of them starts.
  const heavy = heavyStages(test).map((stage) => stage.name);
  expect(heavy).toEqual([
    "bun run deadcode",
    "bun run audit",
    "bun run quality",
    "bun run test '--path-ignore-patterns=suite/**'",
    "bun run build",
  ]);
  expect(full).toEqual([...fast, ...heavy]);
  // The repository checks, stated here rather than read back from CHECKS:
  // the lockstep gate first, judging install scripts before anything else.
  expect(CHECKS.map((stage) => stage.name)).toEqual([
    "bun scripts/check-supply-chain-lockstep.ts",
    "bun scripts/check-md-links.ts",
    "bun scripts/check-instruction-paths.ts",
    "bun scripts/check-skill-fallbacks.ts",
    "bun scripts/check-md-tables.ts",
    "bun scripts/check-glossary-coverage.ts",
    "bun scripts/check-no-tracker-refs.ts",
    "bun scripts/check-tracker-boundary.ts",
    "bun scripts/check-records-registry.ts",
    "bun scripts/check-throws.ts",
    "bun scripts/check-licences.ts",
    "bun scripts/check-workflow-safety.ts",
    "bun scripts/check-workflow-conventions.ts",
    "bun scripts/check-schedules-declared.ts",
    "bun scripts/check-nightly-baseline.ts",
    "bun scripts/check-lifecycle-map.ts",
    "bun scripts/check-changelog.ts",
    "bun scripts/check-audit-fit.ts",
    "bun scripts/change-areas.ts --check",
    "bun scripts/check-generated-files.ts",
    "bun scripts/review-risk.ts --check",
    "bun scripts/check-roadmap.ts",
    "bun scripts/check-plugin.ts",
    "bun scripts/check-skill-shell-neutrality.ts",
    "bun scripts/check-voice.ts",
  ]);
});

test("the checks and tests parts together run every stage of the full set once", async () => {
  const { plan, partOf, PART_ENV, testStage } = await import("./gates.ts");
  const test = testStage(["suite/**"], () => []);
  const full = plan(false, test).map((stage) => stage.name);
  const checks = plan(false, test, "checks").map((stage) => stage.name);
  const tests = plan(false, test, "tests").map((stage) => stage.name);
  expect(tests).toEqual([test.name]);
  expect(checks).not.toContain(test.name);
  expect([...checks, ...tests].sort()).toEqual([...full].sort());
  // The fast set is the same whatever part is named.
  expect(plan(true, test, "tests")).toEqual(plan(true, test));
  expect(partOf({})).toBeUndefined();
  expect(partOf({ [PART_ENV]: "" })).toBeUndefined();
  expect(partOf({ [PART_ENV]: "checks" })).toBe("checks");
  expect(partOf({ [PART_ENV]: "tests" })).toBe("tests");
  // A misspelling is refused, not read as "run nothing".
  for (const bad of ["test", "Tests", " tests", "all"])
    expect(() => partOf({ [PART_ENV]: bad })).toThrow(PART_ENV);
});

test("a run names its part in the closing line", async () => {
  const { summary } = await import("./gates.ts");
  const green = [{ name: "bun run lint", status: 0 }];
  expect(summary(green, false, "tests")).toBe("tests gates passed");
  expect(summary(green, false, "checks")).toBe("checks gates passed");
  expect(summary(green, false)).toBe("all gates passed");
});
