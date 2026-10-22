/**
 * The intent-chain writer under a GitHub tracker: `#<n>` is an identifier,
 * its number sets the calibration arm, and the snapshot and `.current` carry
 * the key's file stem (`issue-<n>`).
 */
import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { isIntentChainInput, refocusArm } from "../scripts/intent-chain.ts";

describe("a GitHub issue key in the intent chain", () => {
  it("is an identifier, and no other #-shape is", () => {
    for (const [identifier, ok] of [
      ["#12", true],
      ["#0", false],
      ["o/r#1", false],
    ] as const)
      expect(isIntentChainInput({ issue: { identifier } })).toBe(ok);
  });

  it("buckets the arm by the issue number's parity", () => {
    expect(refocusArm("#401", undefined)).toBe("on");
    expect(refocusArm("#2", undefined)).toBe("off");
  });

  it("names the snapshot and .current by the key's file stem", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-github-"));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env))
        if (
          v !== undefined &&
          !k.startsWith("GIT_") &&
          k !== "CLAUDE_CODE_SESSION_ID" &&
          k !== "CODEX_THREAD_ID"
        )
          env[k] = v;
      env.JIG_OVERLAY = join(repo, "jig.yaml");
      writeFileSync(env.JIG_OVERLAY, "issue_tracker:\n  adapter: github\n");
      expectSpawnExit(Bun.spawnSync(["git", "init", "-q", repo], { env }), 0);
      const input = { issue: { identifier: "#12", description: "Scope." } };
      const r = Bun.spawnSync(
        ["bun", join(import.meta.dir, "../scripts/intent-chain.ts")],
        { cwd: repo, env, stdin: Buffer.from(JSON.stringify(input)) },
      );
      expectSpawnExit(r, 0);
      const chain = join(realpathSync.native(repo), ".context", "intent-chain");
      expect(JSON.parse(r.stdout.toString()).path).toBe(
        join(chain, "issue-12.md"),
      );
      expect(readFileSync(join(chain, ".current"), "utf8")).toBe("issue-12");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
