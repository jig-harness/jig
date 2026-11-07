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

test("the configured review command accepts Jig's catalog and keeps full gates", () => {
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
  expect(plan.validation.verificationChecks).toEqual(["bun run gates"]);
  expect(plan.validation.testbox.required).toBe(false);
});

test("review routing preserves closure, deduplication, deleted paths and strict schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-review-plan-"));
  try {
    mkdirSync(join(dir, ".config"));
    const path = join(dir, ".config/change-areas.yaml");
    const catalog = `areas:
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
