/** Plain lock listings remain local even when a live driver owns a CI hold. */
import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { putLock, writeState } from "./state-rows.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";

for (const args of [[], ["--json"]]) {
  it(`plain listing ${JSON.stringify(args)} does not query the forge for a live held drive`, () => {
    const root = mkdtempSync(join(tmpdir(), "ci-hold-listing-"));
    try {
      const dir = scopedStateDir(root);
      const state = freshState(123);
      state.lastProgressAt = new Date().toISOString();
      state.ciHold = {
        phase: "held",
        eventId: "42",
        actor: "operator",
        addedAtHead: "a".repeat(40),
        createdAt: state.lastProgressAt,
        checkRunWatermark: 1,
      };
      writeState(dir, "123", state);
      putLock(dir, "pr-drive-123", { label: "drive.ts", pid: process.pid });
      const calls = join(root, "forge-called");
      writeFakeProgram(
        join(root, "gh"),
        `#!/usr/bin/env bun\nawait Bun.write(process.env.CI_HOLD_CALLS, 'called'); process.exit(1);\n`,
      );
      const result = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/drives.ts"),
          ...args,
        ],
        {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
          env: {
            ...gitIdentityEnv(),
            DRIVE_PR_STATE_DIR: dir,
            PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
            CI_HOLD_CALLS: calls,
          },
        },
      );
      expectSpawnExit(result, 0);
      expect(existsSync(calls)).toBe(false);
      if (args.includes("--json")) {
        const parsed = JSON.parse(result.stdout.toString());
        expect(parsed.rows[0].state).toBe("live");
        expect(parsed.rows[0].doctor.verdict).toBe("HEALTHY");
        expect(parsed.rows[0].doctor.ciHold).toBeUndefined();
      } else expect(result.stdout.toString()).toContain("PR #123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
