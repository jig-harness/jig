import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  gitCleanEnv,
  scratchClean,
  SCRIPTS,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { state } from "./drive-loop-harness.ts";
import { fixtureStateTree } from "./scoped-state-dir.ts";
import { writeState } from "./state-rows.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import type { ResolutionReceipt } from "../scripts/lib/state/resolution-receipt.ts";

useDrivePrSuite();
const key = "ci-advisory-head-findings";
const at = "2026-11-13T09:00:00.000Z";
function receipt(option = "fix"): ResolutionReceipt {
  return {
    key,
    kind: "finding",
    class: "reviewer-posture",
    reason: "How should these checks be handled?",
    parkedAt: at,
    resolvedAt: at,
    outcome: "answered",
    answers: [
      {
        author: "owner",
        at,
        url: "https://example.test/answer",
        choice: { option, recommended: true, form: "choose" },
      },
    ],
  };
}

async function claim(dir: string, resolvedAt = at) {
  const p = Bun.spawn(
    scriptArgv(join(SCRIPTS, "drive-state.ts"), "claim-advisory-repair", "999"),
    {
      cwd: fixtureStateTree(dir),
      env: {
        ...gitCleanEnv(),
        DRIVE_PR_STATE_DIR: dir,
        DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
      },
      stdin: new TextEncoder().encode(JSON.stringify({ key, resolvedAt })),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("a fix receipt can be charged once across separate state command processes", async () => {
  const { stateDir } = writeFixture({}, scratchClean.dir);
  writeState(stateDir, "999", {
    ...freshState(999),
    resolvedParks: [receipt()],
  });
  expectSpawnExit(await claim(stateDir), 0);
  const stored = JSON.parse((await state(stateDir, ["get", "999"])).stdout);
  expect(stored.resolvedParks[0].repairStartedAt).toEqual(expect.any(String));
  expectSpawnExit(await claim(stateDir), 3);
});

test("a changed receipt or a waiver cannot authorize a repair", async () => {
  const { stateDir } = writeFixture({}, scratchClean.dir);
  writeState(stateDir, "999", {
    ...freshState(999),
    resolvedParks: [receipt()],
  });
  expectSpawnExit(await claim(stateDir, "2026-11-13T10:00:00.000Z"), 1);
  writeState(stateDir, "999", {
    ...freshState(999),
    resolvedParks: [receipt("waive")],
  });
  expectSpawnExit(await claim(stateDir), 1);
  const stored = JSON.parse((await state(stateDir, ["get", "999"])).stdout);
  expect(stored.resolvedParks[0].repairStartedAt).toBeUndefined();
});
