import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "../lib/vendor/js-yaml.mjs";

const root = resolve(import.meta.dir, "..");

function usesRawBunTest(command: string): boolean {
  const normalized = command.replace(/\\\r?\n[ \t]*/g, " ");
  return /\bbun(?:[ \t]+--\S+(?:[ \t]+(?!test\b)\S+)?)*[ \t]+test\b/.test(
    normalized,
  );
}

test("every CI suite uses the reporting runner and its executed-test check", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.scripts.test).toBe("bun scripts/test.ts");
  const runner = readFileSync(join(root, "scripts/test.ts"), "utf8");
  expect(runner).toContain('"--reporter=junit"');
  expect(runner).toContain("`--reporter-outfile=$" + "{report}`");
  expect(runner).toContain("checkTestsExecuted([report])");
  for (const file of ["gates.yml", "nightly.yml"]) {
    const workflow = loadYaml(
      readFileSync(join(root, ".github/workflows", file), "utf8"),
    ) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    // Direct Bun test commands bypass the fresh report and the tripwire. The
    // suite contracts in gates.test.ts pin selections and complete shard sets.
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? [])
        expect(usesRawBunTest(step.run ?? "")).toBeFalse();
  }
});

test("the suite-runner contract rejects raw Bun spellings", () => {
  for (const command of [
    "bun test scripts/gates.test.ts",
    "bun  test scripts/gates.test.ts",
    "bun --no-env-file test scripts/gates.test.ts",
    "bun --cwd . test scripts/gates.test.ts",
    ["bun", "test scripts/gates.test.ts"].join(" \\\n"),
  ])
    expect(usesRawBunTest(command)).toBeTrue();
  expect(usesRawBunTest("bun run test scripts/gates.test.ts")).toBeFalse();
});
