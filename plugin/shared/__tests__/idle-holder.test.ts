/**
 * idle-holder.ts: a worktree that holds a branch is idle only when its tree
 * is clean, no git operation is unfinished, its commits are on the remote,
 * no drive or session holds it and no process works in it. Each guard is
 * read from a real repository: a clone with an origin, and a linked worktree
 * holding a pushed branch.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GIT_OPERATION_MARKERS,
  holderVerdict,
  parseCwdHolders,
  type TreeDrivers,
} from "../idle-holder.ts";
import { localContext } from "../orca-workspace/runner.ts";
import { BRANCH, git, heldTree } from "./holder-fixture.ts";

const none: TreeDrivers = () => [];

function verdict(holder: string, drivers: TreeDrivers = none) {
  return holderVerdict(
    localContext(() => undefined),
    {
      path: holder,
      branch: BRANCH,
      remote: "origin",
      drivers,
    },
  );
}

/** The verdict's reasons; the test fails when it calls the holder idle. */
function reasons(holder: string, drivers?: TreeDrivers): string[] {
  const v = verdict(holder, drivers);
  if (v.idle) throw new Error("the holder was judged idle");
  return v.reasons;
}

describe("holderVerdict", () => {
  test("calls a clean, pushed, undriven tree with nothing in it idle, at its commit", () => {
    const { holder } = heldTree();
    expect(verdict(holder)).toEqual({
      idle: true,
      head: git(holder, "rev-parse", "HEAD"),
    });
  });

  test("a tracked change keeps it busy", () => {
    const { holder } = heldTree();
    writeFileSync(join(holder, "file.txt"), "two\n");
    expect(reasons(holder)).toEqual([
      "it has uncommitted or untracked changes",
    ]);
  });

  test("an untracked file keeps it busy", () => {
    const { holder } = heldTree();
    writeFileSync(join(holder, "new.txt"), "draft\n");
    expect(reasons(holder)).toEqual([
      "it has uncommitted or untracked changes",
    ]);
  });

  test("an index flag that hides a change keeps it busy", () => {
    const { holder } = heldTree();
    git(holder, "update-index", "--assume-unchanged", "file.txt");
    writeFileSync(join(holder, "file.txt"), "hidden\n");
    expect(reasons(holder)).toEqual([
      "assume-unchanged or skip-worktree flags hide possible changes from git status",
    ]);
  });

  for (const marker of GIT_OPERATION_MARKERS)
    test(`an unfinished operation (${marker}) keeps it busy`, () => {
      const { holder, admin } = heldTree();
      if (marker.includes("-") || marker === "sequencer")
        mkdirSync(join(admin, marker));
      else writeFileSync(join(admin, marker), `${"0".repeat(40)}\n`);
      expect(reasons(holder)).toContain(
        `an unfinished git operation (${marker})`,
      );
    });

  test("a commit origin's branch lacks keeps it busy", () => {
    const { holder } = heldTree();
    git(holder, "commit", "-q", "--allow-empty", "-m", "unpushed");
    expect(reasons(holder)).toEqual([`1 commit(s) not on origin/${BRANCH}`]);
  });

  test("with the branch gone from origin, it is idle only while its commits are on another origin branch", () => {
    const { clone, holder } = heldTree();
    git(clone, "push", "-q", "origin", "--delete", BRANCH);
    git(clone, "fetch", "-q", "--prune", "origin");
    expect(reasons(holder)).toEqual([
      `1 commit(s) on no origin branch, and origin has no ${BRANCH}`,
    ]);
    git(holder, "push", "-q", "origin", `HEAD:refs/heads/elsewhere`);
    expect(verdict(holder).idle).toBe(true);
  });

  test("a live driver or lease keeps it busy, and one that cannot be read does too", () => {
    const { holder } = heldTree();
    let asked: unknown = null;
    expect(
      reasons(holder, (tree) => {
        asked = tree;
        return ["a live driver of PR #7 holds it"];
      }),
    ).toEqual(["a live driver of PR #7 holds it"]);
    expect(asked).toEqual({
      path: holder,
      commonDir: join(holder, "..", "clone", ".git"),
    });
    expect(reasons(holder, () => null)).toEqual([
      "whether a drive or session holds it cannot be read",
    ]);
  });

  test("another branch checked out there keeps it busy", () => {
    const { holder } = heldTree();
    git(holder, "switch", "-q", "-c", "other");
    expect(reasons(holder)).toContain(
      `it has other checked out now, not ${BRANCH}`,
    );
  });

  test.skipIf(process.platform === "win32")(
    "a process working in it keeps it busy",
    () => {
      const { holder } = heldTree();
      const inside = join(holder, "sub");
      mkdirSync(inside);
      const child = Bun.spawn(["sleep", "60"], { cwd: inside });
      try {
        expect(reasons(holder)).toEqual([
          `process ${child.pid} has its working directory in it`,
        ]);
      } finally {
        child.kill();
      }
    },
  );
});

describe("parseCwdHolders", () => {
  test("reads /proc's lines and lsof's fields, matching the tree and what is under it only", () => {
    const top = "/w/holder";
    expect(
      parseCwdHolders(
        "/proc/1\t/\n/proc/2\t/w/holder\n/proc/3\t/w/holder/sub\n/proc/4\t/w/holder-2\n",
        top,
      ),
    ).toEqual(["2", "3"]);
    expect(
      parseCwdHolders("p10\nfcwd\nn/w/holder/x\np11\nfcwd\nn/w/other\n", top),
    ).toEqual(["10"]);
  });
});
