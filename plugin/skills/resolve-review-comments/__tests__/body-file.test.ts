import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

test("reply file input reaches outcome validation before any network request", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-reply-"));
  try {
    const body = join(dir, "reply é.md");
    writeFileSync(body, "`code` $(echo lost) $HOME\n");
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "../scripts/reply-to-thread.ts"),
        "PRRT_x",
        "--body-file",
        body,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expectSpawnExit(
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
      2,
    );
    expect(result.stderr).toContain("body must begin with an outcome token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
