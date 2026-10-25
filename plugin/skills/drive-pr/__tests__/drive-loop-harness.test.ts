/**
 * drive-pr suite: the shell a blocked-pass fixture runs must address the same
 * literal paths the test checks, whatever characters the temporary directory
 * name holds.
 */

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedPassScript } from "./drive-loop-harness.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

describe("blockedPassScript", () => {
  it("reads marker paths holding `$` and a backtick literally", () => {
    const root = mkdtempSync(join(tmpdir(), "blocked-pass-"));
    try {
      const dir = join(root, "a$HOME`true`b");
      mkdirSync(dir);
      const started = join(dir, "started");
      const release = join(dir, "release");
      writeFileSync(release, "");
      const proc = Bun.spawnSync(
        ["sh", "-c", blockedPassScript(started, release)],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );
      expectSpawnExit(proc, 0, "blocked pass");
      expect(existsSync(started)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
