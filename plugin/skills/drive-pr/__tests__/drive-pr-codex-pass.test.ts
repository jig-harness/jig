/**
 * drive-pr suite: the documented Codex pass command. `drive.ts` runs it on
 * the standard tier of `routing.models.codex` (else Codex's own
 * configuration), accepts `--pass-model` overrides, and kills a
 * Codex pass that outruns the pass deadline. The turn-budget hook counts
 * Codex responses and warns, but imposes no runtime turn cap.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { passCommand, skillPrompt } from "../scripts/lib/pass-command.ts";
import { tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";
import { runDrive } from "./drive-loop-harness.ts";
import { ownTree } from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();

const ROUND_READY = {
  threads: [
    {
      id: "PRRT_codex_probe",
      path: "a.ts",
      bot: true,
      comments: [{ author: "example-review[bot]", bot: true, body: "x" }],
    },
  ],
};

const CODEX_PASS = passCommand("codex", 999, true);

/** The command the dry run says it would run. */
function wouldRun(stderr: string): string {
  return /\(dry-run\) would run: (.*)/.exec(stderr)?.[1] ?? "";
}

async function dryRun(flags: string[], env: Record<string, string> = {}) {
  return runDrive(
    ROUND_READY,
    [
      "--dry-run",
      "--no-head-sync",
      "--bots-only",
      ...flags,
      "--",
      ...CODEX_PASS,
    ],
    undefined,
    { env: { DRIVE_PR_QUOTA_NO_SPAWN_PREP: "1", ...env } },
  );
}

describe("the documented Codex pass command", () => {
  it("runs codex exec with the bypass only when the host opted in, its prompt naming the skill and carrying the invocation", () => {
    expect(passCommand("codex", 999)).toEqual([
      "codex",
      "exec",
      "Use the jig:drive-pr skill: /jig:drive-pr --bots-only 999",
    ]);
    expect(passCommand("codex", 999, false)).toEqual(passCommand("codex", 999));
    expect(CODEX_PASS).toEqual([
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "Use the jig:drive-pr skill: /jig:drive-pr --bots-only 999",
    ]);
    expect(passCommand("claude", 999)).toEqual([
      "claude",
      "-p",
      "/jig:drive-pr --bots-only 999",
    ]);
    expect(passCommand("claude", 999, true)).toEqual(
      passCommand("claude", 999),
    );
    expect(skillPrompt("codex", "/followup 12")).toBe(
      "Use the followup skill: /followup 12",
    );
  });

  it("still starts a Codex pass command with no bypass, and its log says inherited", async () => {
    const r = await runDrive(
      ROUND_READY,
      [
        "--dry-run",
        "--no-head-sync",
        "--bots-only",
        "--",
        ...passCommand("codex", 999),
      ],
      undefined,
      {
        env: {
          DRIVE_PR_QUOTA_NO_SPAWN_PREP: "1",
          JIG__DRIVE__CODEX_BYPASS: "true",
        },
      },
    );
    expect(wouldRun(r.stderr)).toBe(
      "codex exec -m gpt-5.6-terra Use the jig:drive-pr skill: /jig:drive-pr --bots-only 999",
    );
    expect(r.stderr).toContain(
      "permission mode: inherited (the pass command sets no --sandbox; Codex's configuration decides)",
    );
  });

  it("runs on the standard tier of routing.models.codex, added after exec as the model its family names", async () => {
    const r = await dryRun([], {
      JIG__ROUTING__MODELS__CODEX__STANDARD: "sol",
    });
    expect(wouldRun(r.stderr)).toStartWith(
      "codex exec -m gpt-6.1-sol --dangerously-bypass-approvals-and-sandbox",
    );
    expect(r.stderr).toContain(
      "pass model: gpt-6.1-sol (routing.models.codex.standard (sol))",
    );
    expect(r.stderr).toContain(
      "permission mode: no sandbox, no approvals (the pass command's --dangerously-bypass-approvals-and-sandbox)",
    );
  });

  it("runs the standard tier's default Codex model when routing.models.codex names none, and ignores drive.pass_model", async () => {
    const r = await dryRun([], { JIG__DRIVE__PASS_MODEL: "opus" });
    expect(wouldRun(r.stderr)).toStartWith(
      "codex exec -m gpt-5.6-terra --dangerously-bypass-approvals-and-sandbox",
    );
    expect(wouldRun(r.stderr)).not.toContain("opus");
    expect(r.stderr).toContain(
      "pass model: gpt-5.6-terra (routing.models.codex.standard (terra))",
    );
  });

  it("overrides the Codex model through --pass-model", async () => {
    const r = await dryRun(["--pass-model", "gpt-override"]);
    expectSpawnExit({ ...r, stdout: null }, 0);
    expect(wouldRun(r.stderr)).toStartWith("codex exec -m gpt-override ");
  });

  it("kills a Codex pass that outruns a positive pass deadline", async () => {
    const bin = join(tmpRoot, "codex-hang-bin");
    mkdirSync(bin, { recursive: true });
    writeFakeProgram(
      join(bin, "codex"),
      "#!/usr/bin/env bun\nawait Bun.sleep(60_000);\n",
    );
    const started = Date.now();
    const r = await runDrive(
      ROUND_READY,
      [
        "--no-head-sync",
        "--bots-only",
        "--pass-timeout",
        "1",
        "--",
        ...CODEX_PASS,
      ],
      ownTree("codex-deadline"),
      {
        env: {
          JIG__DRIVE__PASS_DEADLINE_RETRIES: "0",
          DRIVE_PR_QUOTA_NO_SPAWN_PREP: "1",
        },
        extraBinDir: bin,
      },
    );
    expectSpawnExit({ ...r, stdout: null }, 15);
    expect(r.stderr).toContain("was killed");
    // Killed at its one-second deadline, long before the pass would have ended.
    expect(Date.now() - started).toBeLessThan(50_000);
  }, 120_000);
});
