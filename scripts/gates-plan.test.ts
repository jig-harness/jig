import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import { withoutLeakyGitEnv } from "../plugin/shared/guarded-git-spawn.ts";

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

const launch = { JIG_LAUNCH: "20260101T000000Z-abcdef12" };

function git(cwd: string, ...args: string[]): void {
  const child = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, env: withoutLeakyGitEnv(process.env) },
  );
  expectSpawnExit(child, 0, `git ${args.join(" ")}`);
}

/** A repository whose one change, against origin/main, is `lib/thing.ts`. */
function changedRepository(config: string): string {
  const root = mkdtempSync(join(tmpdir(), "jig-dispatch-gates-"));
  roots.push(root);
  const files: Record<string, string> = {
    ".config/jig.yaml": config,
    "lib/thing.ts": "export const thing = 1;\n",
    "lib/thing.test.ts": "",
    "lib/plain.test.ts": 'import { thing } from "./thing.ts";\n',
    "lib/bare.test.ts": 'import { thing } from "./thing";\n',
    "other/late.test.ts": 'await import("../lib/thing.ts");\n',
    "other/dynamic.test.ts": "await import(`../lib/${name}.ts`);\n",
    "other/unrelated.test.ts": 'import { x } from "./x.ts";\n',
    "website/site.test.ts": 'import { thing } from "../lib/thing.ts";\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(root, "lib/thing.ts"), "export const thing = 2;\n");
  return root;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("only an opted-in dispatch launch runs the targeted form", async () => {
  const { gateRun, testStage } = await import("./gates.ts");
  const on = changedRepository("gates:\n  dispatch_fast: true\n");
  const off = changedRepository("gates:\n  command: bun run gates\n");
  const full = testStage([], () => []).name;
  const names = (run: { stages: { name: string }[] }) =>
    run.stages.map((stage) => stage.name);
  const targeted = gateRun(false, undefined, on, launch);
  expect(targeted.dispatch).toBe(true);
  expect(names(targeted)).not.toContain(full);
  expect(targeted.stages.at(-1)?.name).toBe(
    "RESOURCE_LOCK_BYPASS=1 bun scripts/test.ts --parallel=1 --timeout 60000 ./lib/bare.test.ts ./lib/plain.test.ts ./lib/thing.test.ts ./other/late.test.ts",
  );
  for (const run of [
    gateRun(false, undefined, off, launch),
    gateRun(false, undefined, on, {}),
    gateRun(false, undefined, on, { JIG_LAUNCH: "drive-pr 14 driver 2" }),
    gateRun(false, undefined, on, { ...launch, CI: "true" }),
  ]) {
    expect(run.dispatch).toBe(false);
    expect(names(run)).toContain(full);
  }
  expect(gateRun(true, undefined, on, launch).dispatch).toBe(false);
  expect(gateRun(false, "checks", on, launch).dispatch).toBe(false);
});

test("the targeted tests run outside the lock, without the line's variables", async () => {
  const { dispatchPlan } = await import("./gates.ts");
  const stage = dispatchPlan(["scripts/example.test.ts"], {
    ...launch,
    DRIVE_PR_TARGET: "14",
    PATH: "/bin",
  }).at(-1);
  expect(stage).toMatchObject({
    command: [
      "scripts/test.ts",
      "--parallel=1",
      "--timeout",
      "60000",
      "./scripts/example.test.ts",
    ],
    env: { PATH: "/bin", RESOURCE_LOCK_BYPASS: "1" },
  });
  expect(Object.keys((stage as { env: object }).env).sort()).toEqual([
    "PATH",
    "RESOURCE_LOCK_BYPASS",
  ]);
});

test("the website's tests run only where its dependencies are installed", async () => {
  const { dispatchTestPaths } = await import("./dispatch-gates.ts");
  const root = changedRepository("gates:\n  dispatch_fast: true\n");
  expect(dispatchTestPaths(root).tests).not.toContain("website/site.test.ts");
  mkdirSync(join(root, "website/node_modules"), { recursive: true });
  expect(dispatchTestPaths(root).tests).toContain("website/site.test.ts");
});

test("a selection that fails could not check, and the other stages still run", async () => {
  const { dispatchPlan, gateRun, runStages } = await import("./gates.ts");
  const root = changedRepository("gates:\n  dispatch_fast: true\n");
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const run = gateRun(false, undefined, root, launch);
  expect(run.dispatch).toBe(true);
  expect(run.stages.map((stage) => stage.name)).toEqual([
    ...dispatchPlan([], launch).map((stage) => stage.name),
    "dispatch test selection",
  ]);
  const last = run.stages.at(-1);
  if (!last) throw new Error("the run has no stages");
  expect(await runStages([last], root)).toEqual([
    { name: "dispatch test selection", status: 2 },
  ]);
});

test("a change that selects no test adds no test stage", async () => {
  const { dispatchPlan, plan, testStage } = await import("./gates.ts");
  const quick = plan(
    true,
    testStage([], () => []),
  ).map((stage) => stage.name);
  expect(dispatchPlan([], {}).map((stage) => stage.name)).toEqual(quick);
});

test("targeted gates select changed tests and nearby tests named for changed sources", async () => {
  const { selectDispatchTests } = await import("./dispatch-gates.ts");
  expect(
    selectDispatchTests(
      [
        "plugin/dispatch/lib/run.ts",
        "scripts/gates-plan.test.ts",
        "scripts/deleted.test.ts",
      ],
      [
        "plugin/dispatch/__tests__/run.test.ts",
        "plugin/dispatch/__tests__/run-timeout.test.ts",
        "plugin/dispatch/__tests__/launch.test.ts",
        "plugin/dispatch/__tests__/session.test.ts",
        "plugin/dispatch/__tests__/fixtures/run.test.ts",
        "plugin/other/__tests__/run.test.ts",
        "scripts/gates-plan.test.ts",
      ],
      (test) =>
        test.endsWith("/session.test.ts") ? ["plugin/dispatch/lib/run.ts"] : [],
    ),
  ).toEqual({
    tests: [
      "plugin/dispatch/__tests__/run-timeout.test.ts",
      "plugin/dispatch/__tests__/run.test.ts",
      "plugin/dispatch/__tests__/session.test.ts",
      "scripts/gates-plan.test.ts",
    ],
    leftToCi: 0,
  });
});

test("the limit keeps changed tests first, then nearby ones, then importers", async () => {
  const { selectDispatchTests } = await import("./dispatch-gates.ts");
  const importers = ["a", "b", "c", "d"].map((name) => `t/${name}.test.ts`);
  const select = (limit: number) =>
    selectDispatchTests(
      ["lib/run.ts", "t/z.test.ts"],
      [...importers, "t/z.test.ts", "lib/run.test.ts"],
      (test) => (importers.includes(test) ? ["lib/run.ts"] : []),
      limit,
    );
  expect(select(3)).toEqual({
    tests: ["lib/run.test.ts", "t/a.test.ts", "t/z.test.ts"],
    leftToCi: 3,
  });
  expect(select(1)).toEqual({ tests: ["t/z.test.ts"], leftToCi: 5 });
});

test("a command stage runs with exactly the environment it names", async () => {
  const { runStages } = await import("./gates.ts");
  const probe = [
    "-e",
    "process.exit(process.env.STAGE_PROBE === '1' && !process.env.PATH ? 0 : 1)",
  ];
  const [named, unnamed] = await runStages(
    [
      { name: "named", command: probe, env: { STAGE_PROBE: "1" } },
      { name: "unnamed", command: probe },
    ],
    import.meta.dir,
  );
  // Each stage's output goes straight to this run's own.
  const exit = (status = -1) => ({
    exitCode: status,
    stdout: null,
    stderr: null,
  });
  expectSpawnExit(exit(named?.status), 0, "named");
  expectSpawnExit(exit(unnamed?.status), 1, "unnamed");
});
