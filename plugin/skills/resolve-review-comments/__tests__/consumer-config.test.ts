/**
 * consumer-config.ts: the gate command is the one value the procedure needs.
 * Each case builds a scratch repository and runs the script in it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "consumer-config.ts");

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rrc-consumer-config-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function runConfig(overlay: string) {
  mkdirSync(join(repo, ".config"), { recursive: true });
  writeFileSync(join(repo, ".config", "jig.yaml"), overlay);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "JIG_OVERLAY") env[k] = v;
  env.JIG_CONSUMER_ROOT = repo;
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  return { ...r, exitCode: r.status };
}

test("the gate command alone is a usable configuration", () => {
  // Any reviewer's threads are worked without a reviewer list, and the
  // deferral team is needed only when a finding is deferred.
  const result = runConfig("gates:\n  command: make check\n");
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("gates.command: make check\n");
  expect(result.stdout).toContain("review.bots: (not set: any reviewer)\n");
  expect(result.stdout).toContain(
    "review.deferral_team: (not set: needed only to defer; pass --team)\n",
  );
});

test("a configuration without the gate command is refused", () => {
  const result = runConfig('review:\n  bots: ["example-review[bot]"]\n');
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("lacks required values: gates.command\n");
});
