import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

/** Give forge integration tests an isolated Git identity and executable directory. */
export function createThreadWorktree(
  prefix: string,
  env: Record<string, string>,
) {
  const tmpRoot = mkdtempSync(join(tmpdir(), prefix));
  const binDir = join(tmpRoot, "bin");
  const scratchWorktree = join(tmpRoot, "worktree");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scratchWorktree, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: scratchWorktree,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(init, 0);
  return { tmpRoot, binDir, scratchWorktree };
}
