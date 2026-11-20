import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import { readCatalog } from "./change-areas.ts";

const root = resolve(import.meta.dir, "..");
const script = join(root, "scripts/validation-plan.ts");

function run(cwd: string, input: string) {
  return Bun.spawnSync([process.execPath, script], {
    cwd,
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Jig's plan for `files`, as drive-pr, review and fix-ci read it. */
function jigPlan(...files: string[]) {
  const result = run(root, `${files.join("\n")}\n`);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout.toString()).validation as {
    profiles: string[];
    localChecks: string[];
    verificationChecks: string[];
  };
}

const runsTests = (checks: string[]) =>
  checks.some((c) => c === "bun run gates" || c.startsWith("bun run test"));

test("the configured review command accepts Jig's catalog and runs the full gates for configuration", () => {
  const config = readCatalog(join(root, ".config/jig.yaml")) as {
    drive: { validation_plan_command?: string };
  };
  expect(config.drive.validation_plan_command).toBe(
    "bun scripts/validation-plan.ts",
  );
  const result = run(
    root,
    ".config/jig.yaml\nplugin/skills/drive-pr/scripts/drive.ts\n",
  );
  expectSpawnExit(result, 0);
  const plan = JSON.parse(result.stdout.toString());
  expect(plan.areas).toContain("drive-pr");
  expect(plan.reviewSkills).toEqual([]);
  expect(plan.postDeploy).toEqual([]);
  expect(plan.validation.profiles).toContain("deep");
  expect(plan.validation.localChecks).toContain("bun run gates");
  expect(plan.validation.verificationChecks[0]).toBe("bun run gates");
  expect(plan.validation.testbox.required).toBe(false);
});

test("a documentation-only change's plan names no test run", () => {
  const plan = jigPlan(
    "changes/a-note.md",
    "docs/LIFECYCLE.md",
    "design/plan.md",
  );
  expect(plan.profiles).toEqual(["docs"]);
  expect(plan.localChecks).toEqual(["bun run gates --fast"]);
  expect(runsTests(plan.localChecks)).toBe(false);
  expect(runsTests(plan.verificationChecks)).toBe(false);
});

test("a change to one skill runs that skill's own tests beside the quick gates", () => {
  const plan = jigPlan("plugin/skills/explain/scripts/sheet.ts");
  expect(plan.profiles).toEqual(["area"]);
  // The quick gates hold the typecheck and every generated-file check.
  expect(plan.localChecks).toEqual([
    "bun run gates --fast",
    "bun run test ./plugin/skills/explain/ ./plugin/shared/__tests__/",
  ]);
  expect(plan.verificationChecks).not.toContain("bun run gates");
  expect(plan.verificationChecks).toContain(
    "bun run test ./plugin/skills/explain/ ./plugin/shared/__tests__/",
  );
  // A generator whose source the change touches is owed a run.
  const dashboard = jigPlan("dashboard/src/main.tsx");
  expect(dashboard.localChecks[0]).toBe("bun dashboard/build.ts");
  expect(dashboard.verificationChecks).toContain(
    "bun dashboard/build.ts --check",
  );
});

test("a file no area matches, or code no area's own tests cover, runs the full gates", () => {
  for (const file of ["stray-file.xyz", "plugin/jig.ts"]) {
    const plan = jigPlan("plugin/skills/explain/scripts/sheet.ts", file);
    expect(plan.profiles).toContain("deep");
    expect(plan.localChecks).toEqual(["bun run gates"]);
    expect(plan.verificationChecks).toEqual(["bun run gates"]);
  }
});

test("review routing preserves closure, deduplication, deleted paths and strict schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-review-plan-"));
  try {
    mkdirSync(join(dir, ".config"));
    const path = join(dir, ".config/change-areas.yaml");
    const catalog = `profiles:
  full: {localChecks: [make check], verificationChecks: [make check]}
areas:
  core:
    title: Core
    category: library
    workspace: []
    impliedBy: []
    deployTier: none
    paths: ['core/**']
    reviewRisk: high
    review: {skills: [security]}
  app:
    title: App
    category: service
    workspace: []
    deployTier: none
    paths: ['app/**']
    impliedBy: [core]
    review: {skills: [security, contract]}
    postDeploy: [{action: Check deployment, when: after-merge, envs: [production]}]
`;
    writeFileSync(path, catalog);
    const result = run(dir, "core/deleted.ts\ncore/deleted.ts\n");
    expectSpawnExit(result, 0);
    const plan = JSON.parse(result.stdout.toString());
    expect(plan.seedAreas).toEqual(["core"]);
    expect(plan.areas).toEqual(["app", "core"]);
    expect(plan.reviewSkills).toEqual(["security", "contract"]);
    expect(plan.postDeploy).toHaveLength(1);
    expect(plan.validation.repositoryHooksRequired).toBe(true);
    expect(plan.validation.githubCiRequired).toBe(true);
    const empty = run(dir, "");
    expectSpawnExit(empty, 0);
    expect(JSON.parse(empty.stdout.toString()).areas).toEqual([]);
    writeFileSync(path, catalog.replace("reviewRisk: high", "reviewRisk: low"));
    expectSpawnExit(run(dir, "core/deleted.ts\n"), 2);
    writeFileSync(path, catalog.replace("reviewRisk: high", "reviews: []"));
    expectSpawnExit(run(dir, "core/deleted.ts\n"), 2);
    writeFileSync(
      path,
      catalog.replace("impliedBy: [core]", "impliedBy: [missing]"),
    );
    expectSpawnExit(run(dir, "core/deleted.ts\n"), 2);
    rmSync(path);
    expectSpawnExit(run(dir, "core/deleted.ts\n"), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
