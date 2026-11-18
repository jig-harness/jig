/** Local-git helpers for tests that build a throwaway checkout. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../shared/guarded-git-spawn.ts";

export function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, env: withoutLeakyGitEnv(process.env) },
  );
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
}

/** A new temporary directory under `dirs`, which the caller removes after each test. */
export function scratchDir(prefix: string, dirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
