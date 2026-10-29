/**
 * attach-pr.ts --place: which working tree drives a pull request. From the
 * clone's primary checkout, the tree holding it, else a new tree under
 * `gc.worktree_roots`; for another repository, the clone `clones` maps it to,
 * or the command to run there.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  branchOf,
  type Clone,
  driveState,
  makeClone,
  plantLiveLock,
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

/** A clone whose configuration names `<root>/trees` as its worktree root. */
function withRoots(): { c: Clone; roots: string } {
  const c = fresh();
  const roots = join(c.root, "trees");
  c.env.JIG__GC__WORKTREE_ROOTS = `[${roots}]`;
  return { c, roots };
}

describe("attach-pr.ts --place", () => {
  test("from the primary checkout creates a tree under gc.worktree_roots", () => {
    const { c, roots } = withRoots();
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
    // Placing again finds the tree that holds the branch now.
    const again = c.attach(c.primary, "42", "--place");
    expectSpawnExit(again, 0, "attach --place again");
    expect(JSON.parse(again.stdout)).toMatchObject({
      tree: placed.tree,
      created: false,
    });
  });

  test("from another working tree drives from that tree", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const r = c.attach(tree, "42", "--place");
    expectSpawnExit(r, 0, "attach --place");
    expect(JSON.parse(r.stdout)).toMatchObject({ tree, created: false });
    expect(branchOf(c, tree)).toBe("feature");
  });

  test("refuses to create a tree with no gc.worktree_roots", () => {
    const c = fresh();
    const r = c.attach(c.primary, "42", "--place");
    expectSpawnExit(r, 2, "attach --place");
    expect(r.stderr).toContain("gc.worktree_roots names no root");
  });

  test("refuses a path that already exists", () => {
    const { c, roots } = withRoots();
    mkdirSync(join(roots, "clone-pr-42"), { recursive: true });
    const r = c.attach(c.primary, "42", "--place");
    expectSpawnExit(r, 2, "attach --place");
    expect(r.stderr).toContain("already exists");
  });

  test("creates nothing for a PR the attach would refuse", () => {
    const { c, roots } = withRoots();
    c.pr({ isCrossRepository: true });
    const r = c.attach(c.primary, "42", "--place");
    expectSpawnExit(r, 2, "attach --place");
    expect(() => realpathSync(join(roots, "clone-pr-42"))).toThrow();
  });

  test("creates nothing when origin is not the PR's repository", () => {
    const { c, roots } = withRoots();
    c.pr({ headRepositoryOwner: { login: "other" } });
    const r = c.attach(c.primary, "42", "--place");
    expectSpawnExit(r, 2, "attach --place");
    expect(r.stderr).toContain("'origin' is example/app");
    expect(() => realpathSync(join(roots, "clone-pr-42"))).toThrow();
  });

  test("reuses a tree it created when the attach there did not finish", () => {
    const { c, roots } = withRoots();
    const lock = join(c.env.DRIVE_PR_STATE_DIR as string, "pr-drive-42.lock");
    plantLiveLock(c, "pr-drive-42.lock");
    const first = c.attach(c.primary, "42", "--place");
    expectSpawnExit(first, 11, "attach --place, PR held");
    const tree = realpathSync(join(roots, "clone-pr-42"));
    rmSync(lock, { recursive: true, force: true });
    const again = c.attach(c.primary, "42", "--place");
    expectSpawnExit(again, 0, "attach --place again");
    expect(JSON.parse(again.stdout)).toMatchObject({ tree });
    expect(branchOf(c, tree)).toBe("feature");
    expect(driveState(c, tree).drivenBranch).toMatchObject({ created: true });
    // The drive's own attach, which is not told the tree was created, keeps
    // the provenance the state already holds.
    const drive = c.attach(tree, "42");
    expectSpawnExit(drive, 0, "attach in the placed tree");
    expect(JSON.parse(drive.stdout)).toMatchObject({ created: true });
    expect(driveState(c, tree).drivenBranch).toMatchObject({ created: true });
  });

  test("names the command to run for another repository with no clone mapped", () => {
    const c = fresh();
    c.env.FAKE_GH_REPO = "example/here";
    const r = c.attach(c.primary, "example/elsewhere#7", "--place");
    expectSpawnExit(r, 3, "attach --place");
    expect(r.stderr).toContain("/jig:drive-pr 7");
    expect(r.stderr).toContain("example/elsewhere");
  });

  test("places another repository's PR in the clone `clones` maps it to", () => {
    const { c, roots } = withRoots();
    const elsewhere = join(c.root, "elsewhere");
    mkdirSync(elsewhere);
    c.git(elsewhere, "init", "-q");
    c.env.FAKE_GH_REPOS = JSON.stringify({
      [realpathSync(elsewhere)]: "example/elsewhere",
      [c.root]: "example/app",
    });
    writeFileSync(
      join(c.env.JIG_HOME as string, "jig.yaml"),
      `clones:\n  example/app: ${c.primary}\n`,
    );
    const r = c.attach(
      elsewhere,
      "https://github.com/example/app/pull/42",
      "--place",
    );
    expectSpawnExit(r, 0, "attach --place");
    const placed = JSON.parse(r.stdout) as { tree: string };
    expect(placed).toMatchObject({
      pr: "42",
      repo: "example/app",
      created: true,
    });
    expect(placed.tree.startsWith(roots)).toBe(true);
  });

  test("creates another repository's tree under that clone's roots, not this session's overlay", () => {
    const c = fresh();
    const roots = join(c.root, "trees");
    mkdirSync(join(c.primary, ".config"), { recursive: true });
    writeFileSync(
      join(c.primary, ".config", "jig.yaml"),
      `gc:\n  worktree_roots: [${roots}]\n`,
    );
    const elsewhere = join(c.root, "elsewhere");
    mkdirSync(elsewhere);
    c.git(elsewhere, "init", "-q");
    // This session's overlay names no roots; the destination's file does.
    const overlay = join(c.root, "session-overlay.yaml");
    writeFileSync(overlay, "gc:\n  worktree_roots: []\n");
    c.env.JIG_OVERLAY = overlay;
    c.env.FAKE_GH_REPOS = JSON.stringify({
      [realpathSync(elsewhere)]: "example/elsewhere",
      [c.root]: "example/app",
    });
    writeFileSync(
      join(c.env.JIG_HOME as string, "jig.yaml"),
      `clones:\n  example/app: ${c.primary}\n`,
    );
    const r = c.attach(elsewhere, "example/app#42", "--place");
    expectSpawnExit(r, 0, "attach --place");
    const placed = JSON.parse(r.stdout) as {
      tree: string;
      env: { unset: string[] };
    };
    expect(placed.tree.startsWith(roots)).toBe(true);
    expect(placed.env.unset).toContain("JIG_OVERLAY");
  });

  test("refuses a mapped clone of another repository, or on another host", () => {
    const c = fresh();
    const elsewhere = join(c.root, "elsewhere");
    mkdirSync(elsewhere);
    c.git(elsewhere, "init", "-q");
    c.env.FAKE_GH_REPOS = JSON.stringify({
      [realpathSync(elsewhere)]: "example/elsewhere",
      [c.root]: "example/app",
    });
    writeFileSync(
      join(c.env.JIG_HOME as string, "jig.yaml"),
      `clones:\n  example/other: ${c.primary}\n  example/app: ${c.primary}\n`,
    );
    const wrong = c.attach(elsewhere, "example/other#42", "--place");
    expectSpawnExit(wrong, 2, "attach --place, wrong clone");
    expect(wrong.stderr).toContain(
      "which is a checkout of github.com/example/app",
    );
    const host = c.attach(
      elsewhere,
      "https://forge.example/example/app/pull/42",
      "--place",
    );
    expectSpawnExit(host, 2, "attach --place, other host");
  });
});
