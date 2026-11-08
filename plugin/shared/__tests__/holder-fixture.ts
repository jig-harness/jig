/**
 * A real repository for the tests of a checkout that holds a branch: a clone
 * of a bare origin, and a linked worktree holding a pushed branch with one
 * tracked file. Every directory is removed after the file's tests.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { withoutLeakyGitEnv } from "../guarded-git-spawn.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** git's environment for the fixture: an author, and nothing pointing git at another repository. */
export const ENV = {
  ...withoutLeakyGitEnv(),
  GIT_AUTHOR_NAME: "Probe",
  GIT_AUTHOR_EMAIL: "probe@example.invalid",
  GIT_COMMITTER_NAME: "Probe",
  GIT_COMMITTER_EMAIL: "probe@example.invalid",
};

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, env: ENV, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(r, 0, `git ${args.join(" ")}`);
  return r.stdout.toString().trim();
}

export const BRANCH = "feat/held";

/** A clone of a bare origin, and a linked worktree holding BRANCH, pushed, with one tracked file. */
export function heldTree(): {
  root: string;
  clone: string;
  holder: string;
  admin: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-holder-")));
  roots.push(root);
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  const holder = join(root, "holder");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, clone);
  git(clone, "commit", "-q", "--allow-empty", "-m", "seed");
  git(clone, "push", "-q", "origin", "HEAD:main");
  git(clone, "worktree", "add", "-q", "-b", BRANCH, holder);
  writeFileSync(join(holder, "file.txt"), "one\n");
  git(holder, "add", "file.txt");
  git(holder, "commit", "-q", "-m", "work");
  git(holder, "push", "-q", "origin", BRANCH);
  const admin = git(holder, "rev-parse", "--absolute-git-dir");
  return { root, clone, holder, admin };
}
