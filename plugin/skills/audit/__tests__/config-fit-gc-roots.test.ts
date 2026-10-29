import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function messages(config: string): string[] {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  expectSpawnExit(
    { exitCode: run.code, stdout: run.out, stderr: run.err },
    0,
    "config-fit",
  );
  const report = JSON.parse(run.out) as {
    findings: { id: string; message: string }[];
  };
  return report.findings
    .filter((f) => f.id.startsWith("derivation:"))
    .map((f) => f.message);
}

test("a worktree root or scratch prefix missing here is not a finding", () => {
  expect(
    messages(
      "gc:\n  kinds: [worktrees, scratch]\n  worktree_roots:\n    - ../../orca/workspaces/example\n  scratch_prefixes:\n    - /tmp/example-test.\n",
    ),
  ).toEqual([]);
});

test("a path a skill reads is still a finding when it is missing", () => {
  expect(
    messages("drive:\n  change_areas_catalog: .config/absent.yaml\n"),
  ).toEqual([expect.stringContaining("does not exist")]);
});
