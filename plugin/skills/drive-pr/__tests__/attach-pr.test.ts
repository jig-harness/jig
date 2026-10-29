/**
 * attach-pr.ts: put a working tree on a pull request's head — its branch when
 * free in the clone, its head commit detached when another working tree holds
 * the branch — and refuse, naming the state, where moving would lose or drive
 * around someone's work.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { DRIVEN_TREE_FILE } from "../../../shared/driven-tree.ts";
import {
  branchOf,
  type Clone,
  driveState,
  makeClone,
  plantLiveLock,
  worktreeLock,
} from "./attach-pr-fixtures.ts";

const clones: Clone[] = [];
afterAll(() => {
  for (const c of clones) rmSync(c.root, { recursive: true, force: true });
});
function fresh(): Clone {
  const c = makeClone();
  clones.push(c);
  return c;
}

/** A clone whose `feature` branch is held by a tree named `holder`. */
function held(): { c: Clone; holder: string } {
  const c = fresh();
  const holder = c.tree("holder");
  c.git(holder, "switch", "-q", "feature");
  return { c, holder };
}

function recordFile(c: Clone, tree: string): string {
  return join(c.git(tree, "rev-parse", "--absolute-git-dir"), DRIVEN_TREE_FILE);
}

describe("attach-pr.ts attaches", () => {
  test("the head branch by name when no working tree holds it", () => {
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
    // On a branch the branch answers: no tree record is left behind.
    expect(existsSync(recordFile(c, tree))).toBe(false);
    expect(driveState(c, tree).drivenBranch).toMatchObject({
      branch: "feature",
      remote: "origin",
      worktree: tree,
      detached: false,
      created: false,
    });
  });

  test("the head commit detached when another tree holds the branch", () => {
    const { c } = held();
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
    expect(existsSync(recordFile(c, tree))).toBe(true);
    expect(driveState(c, tree).drivenBranch).toMatchObject({
      branch: "feature",
      worktree: tree,
      detached: true,
    });
  });

  test("a tree detached past the base, whose commits a remote branch holds", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const newer = c.commit(c.primary, "newer.txt");
    c.git(c.primary, "push", "-q", "origin", "HEAD:main");
    c.git(tree, "fetch", "-q", "origin");
    c.git(tree, "checkout", "-q", "--detach", newer);
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    expect(branchOf(c, tree)).toBe("feature");
  });

  test("a tree already on the head branch, leaving what it holds uncommitted", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    c.git(tree, "switch", "-q", "feature");
    writeFileSync(join(tree, "issue.json"), "{}\n");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 0, "attach in place");
    expect(JSON.parse(r.stdout)).toMatchObject({ detached: false });
    expect(existsSync(join(tree, "issue.json"))).toBe(true);
  });

  test("again through its record, catching up to a newer head", () => {
    const { c, holder } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "first attach");
    const newer = c.commit(holder, "round.txt");
    c.git(holder, "push", "-q", "origin", "feature");
    c.pr({ headRefOid: newer });
    expectSpawnExit(c.attach(tree, "42"), 0, "second attach");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(newer);
    expect(branchOf(c, tree)).toBe("");
  });
});

describe("a detached tree's record", () => {
  test("answers the PR when there is no branch to ask gh about", () => {
    const { c } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    // `drive-state.ts` with no PR resolves it the way every script does.
    const r = c.script(tree, "drive-state.ts", "rounds");
    expectSpawnExit(r, 0, "drive-state.ts rounds");
    expect(r.stdout.trim()).toBe("0");
  });

  test("is removed when the tree is attached by name", () => {
    const { c, holder } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "detached attach");
    expect(existsSync(recordFile(c, tree))).toBe(true);
    c.git(tree, "checkout", "-q", "--detach", "main");
    c.git(holder, "switch", "-q", "--detach");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach by name");
    expect(branchOf(c, tree)).toBe("feature");
    expect(existsSync(recordFile(c, tree))).toBe(false);
  });

  test("gives way to the branch once no other tree holds it", () => {
    const { c, holder } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "detached attach");
    c.git(holder, "switch", "-q", "--detach");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 0, "attach again");
    expect(JSON.parse(r.stdout)).toMatchObject({ detached: false });
    expect(branchOf(c, tree)).toBe("feature");
    expect(existsSync(recordFile(c, tree))).toBe(false);
  });

  test("keeps a tree with its own commits detached", () => {
    const { c, holder } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "detached attach");
    const own = c.commit(tree, "own.txt");
    c.git(holder, "switch", "-q", "--detach");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach again");
    expect(branchOf(c, tree)).toBe("");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(own);
  });

  test("stops answering once the tree holds a stacked PR's pushed head", () => {
    const { c } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    // A stacked PR's head descends from this PR's, and another branch holds it.
    c.commit(tree, "stacked.txt");
    c.git(tree, "push", "-q", "origin", "HEAD:refs/heads/stacked");
    c.git(tree, "fetch", "-q", "origin", "stacked:refs/remotes/origin/stacked");
    const r = c.script(tree, "drive-state.ts", "rounds");
    expectSpawnExitNot(r, 0, "drive-state.ts rounds");
  });

  test("keeps answering for the drive's own commit and once it is pushed", () => {
    const { c } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    c.commit(tree, "own.txt");
    const before = c.script(tree, "drive-state.ts", "rounds");
    expectSpawnExit(before, 0, "drive-state.ts rounds, unpushed");
    c.git(tree, "push", "-q", "origin", "HEAD:refs/heads/feature");
    c.git(
      tree,
      "fetch",
      "-q",
      "origin",
      "+feature:refs/remotes/origin/feature",
    );
    const after = c.script(tree, "drive-state.ts", "rounds");
    expectSpawnExit(after, 0, "drive-state.ts rounds, pushed");
  });

  test("stops answering once the tree is detached somewhere else", () => {
    const { c } = held();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    c.git(tree, "checkout", "-q", "--detach", "main");
    const r = c.script(tree, "drive-state.ts", "rounds");
    expectSpawnExitNot(r, 0, "drive-state.ts rounds");
    expect(r.stdout.trim()).not.toBe("0");
  });
});

describe("attach-pr.ts refuses", () => {
  test("a tree with uncommitted changes", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    writeFileSync(join(tree, "scratch.txt"), "left over\n");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("uncommitted changes");
    expect(branchOf(c, tree)).toBe("");
  });

  test("a tree in an unfinished git operation", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const gitDir = c.git(tree, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitDir, "MERGE_HEAD"), `${c.head}\n`);
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("unfinished git operation (MERGE_HEAD)");
  });

  test("a detached head whose commits no branch or remote holds", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    c.commit(tree, "loose.txt");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("no branch or remote holds");
  });

  test("a local branch with commits the PR's head lacks", () => {
    const c = fresh();
    c.git(c.primary, "branch", "-q", "feature", "origin/feature");
    c.git(c.primary, "switch", "-q", "feature");
    c.commit(c.primary, "local.txt");
    c.git(c.primary, "switch", "-q", "main");
    const r = c.attach(c.tree("wt1"), "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("the local branch 'feature' has commits");
  });

  test("a branch that has diverged from the PR's head", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    c.commit(tree, "mine.txt");
    const other = c.tree("other");
    c.git(other, "checkout", "-q", "--detach", c.head);
    const theirs = c.commit(other, "theirs.txt");
    c.git(other, "push", "-q", "origin", `${theirs}:refs/heads/feature`);
    c.pr({ headRefOid: theirs });
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("has diverged");
  });

  test("when the tree holding the branch has commits the PR's head lacks", () => {
    const { c, holder } = held();
    c.commit(holder, "unpushed.txt");
    const tree = c.tree("wt1");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("1 commit(s)");
    expect(r.stderr).toContain(holder);
    expect(c.git(tree, "rev-parse", "HEAD")).not.toBe(c.head);
  });

  test("when the tree holding the branch has uncommitted changes", () => {
    const { c, holder } = held();
    writeFileSync(join(holder, "feature.txt"), "edited\n");
    const r = c.attach(c.tree("wt1"), "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("holding the branch");
  });

  test("a pull request from a fork", () => {
    const c = fresh();
    c.pr({ isCrossRepository: true });
    const r = c.attach(c.tree("wt1"), "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("fork");
  });

  test("an origin that is not the PR's repository", () => {
    const c = fresh();
    c.pr({ headRepositoryOwner: { login: "someone-else" } });
    const r = c.attach(c.tree("wt1"), "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("someone-else/app");
  });

  test("to move the clone's primary checkout off its branch", () => {
    const c = fresh();
    const r = c.attach(c.primary, "42");
    expectSpawnExit(r, 2, "attach");
    expect(r.stderr).toContain("primary checkout");
    expect(branchOf(c, c.primary)).toBe("main");
  });

  test("a closed pull request", () => {
    const c = fresh();
    c.pr({ state: "MERGED" });
    expectSpawnExit(c.attach(c.tree("wt1"), "42"), 5, "attach");
  });

  test("to move a tree another live driver holds, and leaves it as it is", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const before = c.git(tree, "rev-parse", "HEAD");
    plantLiveLock(c, worktreeLock(c, tree));
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 11, "attach");
    expect(r.stderr).toContain("holds this working tree");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(before);
  });

  test("leaves no driver lock behind once it has attached", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    const state = c.env.DRIVE_PR_STATE_DIR as string;
    expect(existsSync(join(state, worktreeLock(c, tree)))).toBe(false);
    expect(existsSync(join(state, "pr-drive-42.lock"))).toBe(false);
  });
});
