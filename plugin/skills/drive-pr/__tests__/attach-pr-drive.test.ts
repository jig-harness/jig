/**
 * The attach inside a drive: `drive.ts` attaches once it holds the tree's
 * lock and the pull request's, so a tree another driver holds is never moved
 * and a second driver of the PR never attaches; `DRIVE_PR_ATTACH` turns it
 * off; and a round's commit made on a detached tree reaches the pull
 * request's head branch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  branchOf,
  type Clone,
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

/** `drive.ts 42` in `tree`, its pass a no-op the arguments name PR 42 to. */
function drive(c: Clone, tree: string, env: Record<string, string> = {}) {
  Object.assign(c.env, env);
  return c.script(tree, "drive.ts", "42", "--", "true", "42");
}

describe("drive.ts attaches under both its locks", () => {
  test("and stops on the attach's refusal", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    writeFileSync(join(tree, "scratch.txt"), "left over\n");
    const r = drive(c, tree);
    expectSpawnExit(r, 2, "drive.ts");
    expect(r.stderr).toContain("uncommitted changes");
  });

  test("never moving a tree another PR's live driver holds", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    c.git(tree, "switch", "-q", "-c", "other");
    plantLiveLock(c, worktreeLock(c, tree));
    const r = drive(c, tree);
    expectSpawnExit(r, 11, "drive.ts");
    expect(branchOf(c, tree)).toBe("other");
  });

  test("leaving the tree as it is when a live driver holds the PR", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const before = c.git(tree, "rev-parse", "HEAD");
    plantLiveLock(c, "pr-drive-42.lock");
    const r = drive(c, tree);
    expectSpawnExit(r, 11, "drive.ts");
    // The PR's lock refuses before the attach runs.
    expect(r.stderr).toContain("already holds the PR #42 lock");
    expect(r.stderr).not.toContain("attach:");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(before);
  });

  test("refusing a PR number #42's own lock would not key", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const before = c.git(tree, "rev-parse", "HEAD");
    plantLiveLock(c, "pr-drive-42.lock");
    // GitHub reads `042` as #42; a lock keyed `042` would not exclude #42's
    // live driver.
    const r = c.script(tree, "drive.ts", "042", "--", "true", "042");
    expectSpawnExit(r, 2, "drive.ts");
    expect(r.stderr).toContain("write PR #42 as 42");
    expect(r.stderr).not.toContain("attach:");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("DRIVE_PR_ATTACH", () => {
  test("off drives the tree as it stands", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    writeFileSync(join(tree, "scratch.txt"), "left over\n");
    plantLiveLock(c, "pr-drive-42.lock");
    const r = drive(c, tree, { DRIVE_PR_ATTACH: "off" });
    // No attach refusal over the dirty tree: the PR lock is what stops it.
    expectSpawnExit(r, 11, "drive.ts");
    expect(r.stderr).not.toContain("attach:");
    expect(branchOf(c, tree)).toBe("");
  });

  test("refuses a value other than on or off", () => {
    const c = fresh();
    const r = drive(c, c.tree("wt1"), { DRIVE_PR_ATTACH: "maybe" });
    expectSpawnExit(r, 2, "drive.ts");
    expect(r.stderr).toContain("DRIVE_PR_ATTACH must be on or off");
  });
});

describe("a round on a detached tree", () => {
  test("commits on the detached head and pushes it to the PR's head branch", () => {
    const c = fresh();
    const holder = c.tree("holder");
    c.git(holder, "switch", "-q", "feature");
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    const fix = c.commit(tree, "fix.txt");
    expect(branchOf(c, tree)).toBe("");
    const pushed = c.script(tree, "guarded-push.ts", "42");
    expectSpawnExit(pushed, 0, "guarded-push.ts");
    const remoteHead = c.git(c.remote, "rev-parse", "refs/heads/feature");
    expect(remoteHead).toBe(fix);
    // The tree still names its PR: its head descends from the attached one.
    const rounds = c.script(tree, "drive-state.ts", "rounds");
    expectSpawnExit(rounds, 0, "drive-state.ts rounds");
  });
});
