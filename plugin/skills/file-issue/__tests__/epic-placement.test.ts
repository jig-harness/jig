import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

test("validates an epic rule and missing facets using the actual filing placement", () => {
  const repo = mkdtempSync(join(tmpdir(), "validate-epic-placement-"));
  const overlay = join(repo, "jig.yaml");
  writeFileSync(overlay, "issue_tracker:\n  labels:\n    epic_types: [Epic]\n");
  const script = join(
    import.meta.dir,
    "fixtures",
    "validator",
    "epic-placement.ts",
  );
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("JIG__")),
    ),
    JIG_CONSUMER_ROOT: repo,
    JIG_OVERLAY: overlay,
    JIG_USER_LAYER: "off",
  };
  const run = (nativeType: string, exempt: boolean) =>
    Bun.spawnSync([process.execPath, script, nativeType, String(exempt)], {
      cwd: repo,
      env,
    });

  expectSpawnExit(run("Epic", true), 0);
  const required = run("Epic", false);
  expectSpawnExit(required, 3);
  const verdict = JSON.parse(required.stdout.toString());
  expect(verdict.missing).toEqual(["size", "priority"]);
  expect(verdict.errors).toHaveLength(2);
  const task = run("Task", true);
  expectSpawnExit(task, 3);
  expect(JSON.parse(task.stdout.toString()).errors).toEqual([
    "'roadmap' requires 'epic' beside it",
  ]);
});
