/**
 * drive-pr suite: the model `drive.ts` runs each pass on — `sonnet` with no
 * setting, `drive.pass_model` or `--pass-model` (a routing tier resolved
 * through the tier-to-model table) when set — named in the driver log and
 * carried by the command a dry run says it would run.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { useDrivePrSuite } from "./drive-pr-harness.ts";
import { runDrive } from "./drive-loop-harness.ts";

useDrivePrSuite();

const ROUND_READY = {
  threads: [
    {
      id: "PRRT_model_probe",
      path: "a.ts",
      bot: true,
      comments: [{ author: "example-review[bot]", bot: true, body: "x" }],
    },
  ],
};
const CLAUDE_PASS = ["claude", "-p", "/jig:drive-pr --bots-only 999"];

async function dryRun(flags: string[], env: Record<string, string> = {}) {
  return runDrive(
    ROUND_READY,
    [
      "--dry-run",
      "--no-head-sync",
      "--bots-only",
      ...flags,
      "--",
      ...CLAUDE_PASS,
    ],
    undefined,
    { env: { DRIVE_PR_QUOTA_NO_SPAWN_PREP: "1", ...env } },
  );
}

/** The command the dry run says it would run. */
function wouldRun(stderr: string): string {
  return /\(dry-run\) would run: (.*)/.exec(stderr)?.[1] ?? "";
}

describe("the pass model", () => {
  it("is sonnet with no setting, added after claude and named in the driver log", async () => {
    const r = await dryRun([]);
    expect(wouldRun(r.stderr)).toBe(
      "claude --model sonnet -p /jig:drive-pr --bots-only 999",
    );
    expect(r.stderr).toContain(
      "pass model: sonnet (the default; drive.pass_model is not set)",
    );
    const log = /driver log → (\S+)/.exec(r.stderr)?.[1] ?? "";
    expect(readFileSync(log, "utf8")).toContain("pass model: sonnet");
  });

  it("is drive.pass_model when set, a tier resolved through routing.models", async () => {
    const r = await dryRun([], { JIG__DRIVE__PASS_MODEL: "strategic" });
    expect(wouldRun(r.stderr)).toStartWith("claude --model opus -p");
    expect(r.stderr).toContain(
      "pass model: opus (drive.pass_model: the strategic tier, routing.models.claude-code.strategic)",
    );
  });

  it("is --pass-model for one run, over the pass command's own --model", async () => {
    const r = await runDrive(
      ROUND_READY,
      [
        "--dry-run",
        "--no-head-sync",
        "--pass-model",
        "haiku",
        "--",
        "claude",
        "--model",
        "opus",
        "-p",
        "/jig:drive-pr 999",
      ],
      undefined,
      { env: { DRIVE_PR_QUOTA_NO_SPAWN_PREP: "1" } },
    );
    expect(wouldRun(r.stderr)).toBe(
      "claude --model haiku -p /jig:drive-pr 999",
    );
    expect(r.stderr).toContain(
      "pass model: haiku (--pass-model, replacing the pass command's --model opus)",
    );
  });

  it("refuses --pass-model for a pass command that chooses its own model", async () => {
    const r = await runDrive({ threads: [] }, [
      "--pass-model",
      "sonnet",
      "--",
      "sh",
      "-c",
      ": pass for 999",
    ]);
    expectSpawnExit({ ...r, stdout: null }, 2);
    expect(r.stderr).toContain("--pass-model applies to a Claude Code pass");
  });

  it("refuses a drive.pass_model that is not one word", async () => {
    const r = await dryRun([], { JIG__DRIVE__PASS_MODEL: "two words" });
    expectSpawnExit({ ...r, stdout: null }, 1);
    expect(r.stderr).toContain("drive.pass_model");
  });
});
