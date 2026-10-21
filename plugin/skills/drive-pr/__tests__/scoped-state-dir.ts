/** Build an explicit clone-scoped override leaf for fixtures that inspect files. */
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";
import { cloneKey } from "../scripts/lib/state/clone-key.ts";

const fixtureTrees = new Map<string, string>();
export const fixtureStateTree = (dir: string): string =>
  fixtureTrees.get(dir) ?? process.cwd();

export function scopedStateDir(root: string, cwd = process.cwd()): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
    cwd,
    env: gitIdentityEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(git, 0);
  const key = cloneKey(resolve(cwd, git.stdout.toString().trim()));
  const dir = basename(root) === key ? root : join(root, key);
  mkdirSync(dir, { recursive: true });
  fixtureTrees.set(dir, cwd);
  return dir;
}

/** A second actor sharing the clone's PR budget and holds. */
export function linkedScratchTree(
  cwd: string,
  dir: string,
): { dir: string; head: string } {
  const added = Bun.spawnSync(
    ["git", "worktree", "add", "-q", "--detach", dir],
    { cwd, env: gitIdentityEnv(), stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(added, 0);
  const advanced = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "sibling head",
    ],
    { cwd: dir, env: gitIdentityEnv(), stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(advanced, 0);
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: dir,
    env: gitIdentityEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(head, 0);
  return { dir, head: head.stdout.toString().trim() };
}
