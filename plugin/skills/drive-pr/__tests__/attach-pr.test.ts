/**
 * attach-pr.ts: put a working tree on a pull request's head — its branch when
 * free in the clone, its head commit detached when another working tree holds
 * the branch — and refuse, naming the state, where moving would lose or drive
 * around someone's work.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { DRIVEN_TREE_FILE } from "../../../shared/driven-tree.ts";
import {
  type Clone,
  driveState,
  makeClone,
  SCRIPTS,
} from "./attach-pr-fixtures.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

const clones: Clone[] = [];
afterAll(() => {
  for (const c of clones) rmSync(c.root, { recursive: true, force: true });
});
function fresh(): Clone {
  const c = makeClone();
  clones.push(c);
  return c;
}

function branchOf(c: Clone, tree: string): string {
  const r = Bun.spawnSync(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      cwd: tree,
      env: c.env,
      stdout: "pipe",
    },
  );
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

describe("attach-pr.ts", () => {
  test("checks the head branch out when no working tree holds it", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 0, "attach");
    expect(JSON.parse(r.stdout)).toMatchObject({
      pr: "42",
      branch: "feature",
      detached: false,
      worktree: tree,
    });
    expect(branchOf(c, tree)).toBe("feature");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(c.head);
    expect(driveState(c, tree).drivenBranch).toMatchObject({
      branch: "feature",
      remote: "origin",
      worktree: tree,
      detached: false,
      created: false,
    });
  });

  test("checks the head commit out detached when another tree holds the branch", () => {
    const c = fresh();
    const holder = c.tree("holder");
    c.git(holder, "switch", "-q", "feature");
    const tree = c.tree("wt1");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 0, "attach");
    expect(JSON.parse(r.stdout)).toMatchObject({ detached: true });
    expect(branchOf(c, tree)).toBe("");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(c.head);
    // No second branch with a suffixed name: the branch list is unchanged.
    const branches = c.git(
      tree,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    );
    expect(branches.split("\n").sort()).toEqual(["feature", "main"]);
    const gitDir = c.git(tree, "rev-parse", "--absolute-git-dir");
    expect(existsSync(join(gitDir, DRIVEN_TREE_FILE))).toBe(true);
    expect(driveState(c, tree).drivenBranch).toMatchObject({
      branch: "feature",
      worktree: tree,
      detached: true,
    });
  });

  test("a detached tree answers the PR from its attach record, with no branch to ask gh about", () => {
    const c = fresh();
    const holder = c.tree("holder");
    c.git(holder, "switch", "-q", "feature");
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    // `drive-state.ts get` with no PR resolves it the way every script does.
    const r = Bun.spawnSync(
      [process.execPath, join(SCRIPTS, "drive-state.ts"), "rounds"],
      { cwd: tree, env: c.env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(r, 0, "drive-state.ts rounds");
    expect(r.stdout.toString().trim()).toBe("0");
  });

  test("refuses a tree with uncommitted changes", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    writeFileSync(join(tree, "scratch.txt"), "left over\n");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("uncommitted changes");
    expect(branchOf(c, tree)).toBe("");
  });

  test("refuses when the tree holding the branch has commits the PR's head lacks", () => {
    const c = fresh();
    const holder = c.tree("holder");
    c.git(holder, "switch", "-q", "feature");
    writeFileSync(join(holder, "unpushed.txt"), "local\n");
    c.git(holder, "add", "-A");
    c.git(holder, "commit", "-qm", "unpushed");
    const tree = c.tree("wt1");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("1 commit(s)");
    expect(r.stderr).toContain(holder);
    expect(c.git(tree, "rev-parse", "HEAD")).not.toBe(c.head);
  });

  test("refuses when the tree holding the branch has uncommitted changes", () => {
    const c = fresh();
    const holder = c.tree("holder");
    c.git(holder, "switch", "-q", "feature");
    writeFileSync(join(holder, "feature.txt"), "edited\n");
    const r = c.attach(c.tree("wt1"), "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("holding the branch");
  });

  test("refuses a pull request from a fork", () => {
    const c = fresh();
    c.pr({ isCrossRepository: true });
    const r = c.attach(c.tree("wt1"), "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("fork");
  });

  test("refuses to move the clone's primary checkout off its branch", () => {
    const c = fresh();
    const r = c.attach(c.primary, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("primary checkout");
    expect(branchOf(c, c.primary)).toBe("main");
  });

  test("a closed pull request is not attached", () => {
    const c = fresh();
    c.pr({ state: "MERGED" });
    expectSpawnExit(c.attach(c.tree("wt1"), "42"), 5, "attach");
  });

  test("--place from the primary checkout creates a tree under gc.worktree_roots", () => {
    const c = fresh();
    const roots = join(c.root, "trees");
    c.env.JIG__GC__WORKTREE_ROOTS = `[${roots}]`;
    const r = c.attach(c.primary, "42", "--place");
    expectSpawnExit(r, 0, "attach --place");
    const placed = JSON.parse(r.stdout) as { tree: string };
    expect(placed).toMatchObject({ pr: "42", created: true });
    expect(placed.tree.startsWith(roots)).toBe(true);
    expect(branchOf(c, placed.tree)).toBe("feature");
    expect(branchOf(c, c.primary)).toBe("main");
    expect(driveState(c, placed.tree).drivenBranch).toMatchObject({
      worktree: placed.tree,
      created: true,
    });
    // Placing again finds the tree it made rather than making another.
    const again = c.attach(c.primary, "42", "--place");
    expectSpawnExit(again, 0, "attach --place again");
    expect(JSON.parse(again.stdout)).toMatchObject({
      tree: placed.tree,
      created: false,
    });
  });

  test("--place names the command to run for another repository with no clone mapped", () => {
    const c = fresh();
    c.env.FAKE_GH_REPO = "example/here";
    const r = c.attach(c.primary, "example/elsewhere#7", "--place");
    expectSpawnExit(r, 3, "attach --place");
    expect(r.stderr).toContain("/jig:drive-pr 7");
    expect(r.stderr).toContain("example/elsewhere");
  });

  test("drive.ts attaches before taking its locks, and stops on a refusal", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    writeFileSync(join(tree, "scratch.txt"), "left over\n");
    const r = Bun.spawnSync(
      [process.execPath, join(SCRIPTS, "drive.ts"), "42", "--", "true", "42"],
      { cwd: tree, env: c.env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(r, 2, "drive.ts");
    expect(r.stderr.toString()).toContain("uncommitted changes");
  });

  test("drive.ts leaves the tree alone when a live driver holds the PR, and the lock refuses", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const before = c.git(tree, "rev-parse", "HEAD");
    const lock = join(
      scopedStateDir(c.env.DRIVE_PR_STATE_DIR as string, tree),
      "pr-drive-42.lock",
    );
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "claim.live0001"),
      `${process.pid} ${hostname()} ${process.platform}\n`,
    );
    const r = Bun.spawnSync(
      [process.execPath, join(SCRIPTS, "drive.ts"), "42", "--", "true", "42"],
      { cwd: tree, env: c.env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(r, 11, "drive.ts");
    expect(r.stderr.toString()).toContain("a live driver already holds PR #42");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(before);
    expect(branchOf(c, tree)).toBe("");
  });
});
