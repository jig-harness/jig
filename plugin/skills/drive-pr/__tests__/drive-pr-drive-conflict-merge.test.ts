/**
 * drive-pr suite: the merge in the tree around a conflict-resolve pass. A merge
 * the pass started and did not conclude (staged, its commit refused) is aborted
 * before the re-gate or the stop, so the next pass and the stop's `Fix:` start
 * from a clean tree. One the tree already held when the pass started is not the
 * pass's own: a re-arm over it reaches the pass with it intact, and it is left
 * for the pass to finish or restart.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  DORMANT_ARM,
  gitCleanEnv,
  tmpRoot,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { runDrive } from "./drive-loop-harness.ts";

useDrivePrSuite();

const CONFLICTING = {
  threads: [],
  checkRuns: [DORMANT_ARM],
  mergeable: "CONFLICTING",
  mergeStateStatus: "DIRTY",
};

let trees = 0;

function gitIn(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: gitCleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString().trim() };
}

/** A tree on `main`, whose `f.txt` conflicts with `other`'s: the merge a conflict round starts. */
function conflictingTree(): string {
  const dir = join(tmpRoot, `conflict-merge-${++trees}`);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const r = gitIn(dir, ...args);
    expect(`git ${args[0]} exited ${r.code}`).toBe(`git ${args[0]} exited 0`);
    return r;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(dir, "f.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base", "--no-verify");
  git("checkout", "-q", "-b", "other");
  writeFileSync(join(dir, "f.txt"), "other\n");
  git("commit", "-qam", "other", "--no-verify");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "f.txt"), "mainline\n");
  git("commit", "-qam", "mainline", "--no-verify");
  return dir;
}

const mergeIsOpen = (dir: string) =>
  gitIn(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").code === 0;

/** A pass for PR 999 that says whether it found a merge open, then runs `then` and exits `exit`. */
function pass(then: string, exit = 0): string[] {
  return [
    "sh",
    "-c",
    `: pass for 999; if git rev-parse -q --verify MERGE_HEAD >/dev/null; then echo "FOUND_A_MERGE" >&2; else echo "FOUND_A_CLEAN_TREE" >&2; fi; ${then}; exit ${exit}`,
  ];
}

/** What a pass does when it resolves the conflict and is refused the commit. */
const STAGES_THE_MERGE =
  "git merge other >/dev/null 2>&1; echo resolved > f.txt; git add f.txt";

const drive = (dir: string, agent: string[], rounds = "1") =>
  runDrive(CONFLICTING, ["--no-head-sync", "--", ...agent], dir, {
    env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: rounds },
  });

describe("the merge a conflict-resolve pass leaves open", () => {
  it("is aborted, whatever the pass exits, and the stop names what it held and a fix that works", async () => {
    for (const exit of [0, 1]) {
      const dir = conflictingTree();
      const head = gitIn(dir, "rev-parse", "HEAD").stdout;
      const r = await drive(dir, pass(STAGES_THE_MERGE, exit));
      expect(r.stderr).toContain("FOUND_A_CLEAN_TREE");
      expectSpawnExit({ ...r, stdout: null }, 9);
      expect(mergeIsOpen(dir)).toBe(false);
      expect(gitIn(dir, "status", "--porcelain").stdout).toBe("");
      expect(gitIn(dir, "rev-parse", "HEAD").stdout).toBe(head);
      expect(r.stderr).toContain("left its merge open; aborted it");
      expect(r.stderr).toContain("M  f.txt");
      expect(r.stderr).not.toContain("still holds an open merge");
      expect(r.stderr).toContain("git merge origin/develop");
      // The merge the stop tells a person to run starts: `1` is its conflict,
      // where an open merge would refuse it with `128`.
      expect(gitIn(dir, "merge", "other").code).toBe(1);
    }
  });

  it("does not reach the next pass of the budget", async () => {
    const dir = conflictingTree();
    const r = await drive(dir, pass(STAGES_THE_MERGE), "2");
    expect(r.stderr).toContain("Running conflict-resolution pass 2/2");
    expect(r.stderr).not.toContain("FOUND_A_MERGE");
    expectSpawnExit({ ...r, stdout: null }, 9);
    expect(mergeIsOpen(dir)).toBe(false);
  });

  it("stays and is reported when git cannot abort it", async () => {
    const dir = conflictingTree();
    // Edited after it was staged: `git merge --abort` refuses to overwrite it.
    const r = await drive(
      dir,
      pass(`${STAGES_THE_MERGE}; echo edited-again > f.txt`),
    );
    expectSpawnExit({ ...r, stdout: null }, 9);
    expect(r.stderr).toContain("did not close it");
    expect(r.stderr).toContain("still holds an open merge (MERGE_HEAD)");
    expect(mergeIsOpen(dir)).toBe(true);
  });

  it("stays when the pass finds the pull request closed", async () => {
    const dir = conflictingTree();
    const r = await drive(dir, pass(STAGES_THE_MERGE, 5));
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).not.toContain("left its merge open");
  });
});

describe("a merge the tree held before the pass", () => {
  /** A tree holding what a pass that was refused its commit left: the merge staged. */
  function treeWithStagedMerge(): string {
    const dir = conflictingTree();
    expect(gitIn(dir, "merge", "other").code).toBe(1);
    writeFileSync(join(dir, "f.txt"), "resolved\n");
    expect(gitIn(dir, "add", "f.txt").code).toBe(0);
    expect(mergeIsOpen(dir)).toBe(true);
    return dir;
  }

  it("reaches the conflict-resolve pass intact, which may conclude it", async () => {
    const dir = treeWithStagedMerge();
    const head = gitIn(dir, "rev-parse", "HEAD").stdout;
    const r = await drive(
      dir,
      pass("git commit -qm 'finish the merge' --no-verify"),
    );
    expect(r.stderr).toContain("Running conflict-resolution pass 1/1");
    expect(r.stderr).toContain("FOUND_A_MERGE");
    expect(mergeIsOpen(dir)).toBe(false);
    expect(gitIn(dir, "rev-parse", "HEAD^1").stdout).toBe(head);
    expect(gitIn(dir, "rev-parse", "HEAD^2").stdout).toBe(
      gitIn(dir, "rev-parse", "other").stdout,
    );
  });

  it("may be aborted and started over by the pass", async () => {
    const dir = treeWithStagedMerge();
    const r = await drive(
      dir,
      pass(
        `git merge --abort; ${STAGES_THE_MERGE}; git commit -qm redone --no-verify`,
      ),
    );
    expect(r.stderr).toContain("FOUND_A_MERGE");
    expect(mergeIsOpen(dir)).toBe(false);
    expect(gitIn(dir, "log", "-1", "--format=%s").stdout).toBe("redone");
  });

  it("is not discarded when the pass leaves it, and the stop says it is there", async () => {
    const dir = treeWithStagedMerge();
    const r = await drive(dir, pass(":"));
    expect(r.stderr).toContain("FOUND_A_MERGE");
    expectSpawnExit({ ...r, stdout: null }, 9);
    expect(mergeIsOpen(dir)).toBe(true);
    expect(gitIn(dir, "diff", "--cached", "--name-only").stdout).toBe("f.txt");
    expect(r.stderr).not.toContain("left its merge open");
    expect(r.stderr).toContain("still holds an open merge (MERGE_HEAD)");
  });
});
