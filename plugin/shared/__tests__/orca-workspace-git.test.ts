import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBranchName,
  assertLinkedWorktree,
  decideBranchAction,
  ensureUpstreamTracking,
  findGitWorktree,
  parseGitWorktreeList,
  probeBranch,
  refreshBaseRef,
  repoIdentity,
} from "../orca-workspace/git.ts";
import { localContext } from "../orca-workspace/runner.ts";
import { fail, fakeContext, ok } from "./fake-context.ts";

const R = "/repo";
const B = "feat/x";
const lsRemote = `git -C ${R} ls-remote --exit-code --heads origin ${B}`;
const fetch = `git -C ${R} fetch --prune origin +refs/heads/${B}:refs/remotes/origin/${B}`;
const remoteRef = `git -C ${R} rev-parse --verify --quiet refs/remotes/origin/${B}`;
const localRef = `git -C ${R} show-ref --verify --quiet refs/heads/${B}`;
const deleteRef = `git -C ${R} update-ref -d refs/remotes/origin/${B}`;
const missing = fail(128, "fatal: couldn't find remote ref refs/heads/feat/x");

describe("decideBranchAction", () => {
  test("neither side has it: create from the base", () => {
    expect(
      decideBranchAction({
        remoteExists: false,
        localExists: false,
        localAhead: [],
      }),
    ).toEqual({ kind: "create-from-base" });
  });
  test("origin only, or local holding nothing more: create from origin", () => {
    expect(
      decideBranchAction({
        remoteExists: true,
        localExists: false,
        localAhead: [],
      }),
    ).toEqual({ kind: "create-from-origin" });
    expect(
      decideBranchAction({
        remoteExists: true,
        localExists: true,
        localAhead: [],
      }),
    ).toEqual({ kind: "create-from-origin" });
  });
  test("local only: use it", () => {
    expect(
      decideBranchAction({
        remoteExists: false,
        localExists: true,
        localAhead: [],
      }),
    ).toEqual({ kind: "use-local" });
  });
  test("local ahead of origin: a person decides", () => {
    expect(
      decideBranchAction({
        remoteExists: true,
        localExists: true,
        localAhead: ["abc"],
      }),
    ).toEqual({ kind: "refuse-diverged", ahead: ["abc"] });
  });
});

describe("probeBranch", () => {
  test("a transport failure of ls-remote is an error, not an absent branch", () => {
    const ctx = fakeContext({
      [lsRemote]: fail(128, "Could not resolve host"),
    });
    expect(() => probeBranch(ctx, R, B)).toThrow(
      "cannot tell whether feat/x exists on origin",
    );
  });

  test("a branch missing on origin deletes the ref an earlier fetch left", () => {
    const ctx = fakeContext({
      [lsRemote]: fail(2),
      [fetch]: missing,
      [deleteRef]: ok(),
      [remoteRef]: fail(1),
      [localRef]: fail(1),
    });
    expect(probeBranch(ctx, R, B)).toEqual({
      remoteExists: false,
      localExists: false,
      localAhead: [],
    });
    expect(ctx.calls).toContain(deleteRef);
    expect(ctx.slept).toEqual([]);
  });

  test("whether origin has it is read after the fetch, not from ls-remote", () => {
    const ctx = fakeContext({
      [lsRemote]: fail(2),
      [fetch]: ok(),
      [remoteRef]: ok("abc"),
      [localRef]: fail(1),
    });
    expect(probeBranch(ctx, R, B).remoteExists).toBe(true);
  });

  test("a failed fetch is retried once, then thrown", () => {
    const ctx = fakeContext({
      [lsRemote]: ok(),
      [fetch]: fail(1, "cannot lock ref: incorrect old value provided"),
    });
    expect(() => probeBranch(ctx, R, B)).toThrow("git fetch failed for feat/x");
    expect(ctx.calls.filter((c) => c === fetch)).toHaveLength(2);
    expect(ctx.slept).toHaveLength(1);
  });

  test("a ref check that cannot answer is an error", () => {
    const ctx = fakeContext({
      [lsRemote]: ok(),
      [fetch]: ok(),
      [remoteRef]: fail(-1, "spawn error: timed out"),
    });
    expect(() => probeBranch(ctx, R, B)).toThrow(
      "cannot tell whether origin/feat/x exists",
    );
  });

  test("both sides: the local commits origin lacks are listed", () => {
    const ctx = fakeContext({
      [lsRemote]: ok(),
      [fetch]: ok(),
      [remoteRef]: ok(),
      [localRef]: ok(),
      [`git -C ${R} rev-list origin/${B}..${B}`]: ok("c1\nc2\n"),
    });
    expect(probeBranch(ctx, R, B).localAhead).toEqual(["c1", "c2"]);
  });
});

describe("ensureUpstreamTracking", () => {
  test("a branch origin has gets it as its upstream", () => {
    const track = `git -C ${R} branch --set-upstream-to origin/${B} ${B}`;
    const ctx = fakeContext({
      [fetch]: ok(),
      [remoteRef]: ok(),
      [track]: ok(),
    });
    ensureUpstreamTracking(ctx, R, B);
    expect(ctx.calls).toContain(track);
  });
  test("a branch never pushed has nothing to track", () => {
    const ctx = fakeContext({
      [fetch]: missing,
      [deleteRef]: ok(),
      [remoteRef]: fail(1),
    });
    ensureUpstreamTracking(ctx, R, B);
    expect(ctx.calls.some((c) => c.includes("--set-upstream-to"))).toBe(false);
  });
});

describe("refreshBaseRef", () => {
  const baseFetch = `git -C ${R} fetch --prune origin +refs/heads/main:refs/remotes/origin/main`;
  test("an origin branch is fetched before a branch is cut from it", () => {
    const ctx = fakeContext({ [baseFetch]: ok() });
    refreshBaseRef(ctx, R, "origin/main");
    expect(ctx.calls).toEqual([baseFetch]);
  });
  test("a base origin does not have is an error, after one retry", () => {
    const ctx = fakeContext({
      [baseFetch]: fail(128, "couldn't find remote ref"),
    });
    expect(() => refreshBaseRef(ctx, R, "origin/main")).toThrow(
      "could not refresh",
    );
    expect(ctx.calls).toHaveLength(2);
  });
  test("a commit or tag is used as given", () => {
    const ctx = fakeContext({});
    refreshBaseRef(ctx, R, "v1.2.0");
    expect(ctx.calls).toEqual([]);
  });
});

describe("worktree lists", () => {
  test("the -z form keeps every path as it is", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /wt/é\ttab",
      "HEAD def",
      "branch refs/heads/feat/x",
      "",
      "worktree /wt/detached",
      "HEAD 123",
      "detached",
      "",
    ].join("\0");
    expect(parseGitWorktreeList(porcelain)).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/wt/é\ttab", branch: "feat/x" },
      { path: "/wt/detached", branch: null },
    ]);
  });
  test("an unreadable list is an error, never 'not checked out'", () => {
    const ctx = fakeContext({
      [`git -C ${R} worktree list --porcelain -z`]: fail(
        128,
        "not a git repository",
      ),
    });
    expect(() => findGitWorktree(ctx, R, B)).toThrow(
      "git worktree list failed",
    );
  });
});

describe("against a real clone", () => {
  const ctx = localContext(() => undefined);
  const git = (cwd: string, ...args: string[]): string => {
    const run = ctx.run(["git", "-C", cwd, ...args]);
    if (run.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-git-")));
  const clone = join(root, "clone");
  git(root, "init", "-q", "-b", "main", clone);
  git(
    clone,
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  const linked = join(root, "linked");
  git(clone, "worktree", "add", "-q", "-b", "feat/y", linked);

  test("the primary checkout is refused, a linked worktree accepted", () => {
    expect(() => assertLinkedWorktree(ctx, clone, "use it")).toThrow(
      "primary checkout",
    );
    assertLinkedWorktree(ctx, linked, "use it");
  });
  test("the clone's identity is the same from every worktree", () => {
    expect(repoIdentity(ctx, linked)).toBe(repoIdentity(ctx, clone));
  });
  test("a branch name git refuses is refused", () => {
    expect(() => assertBranchName(ctx, "bad..name")).toThrow(
      "not a valid branch name",
    );
    assertBranchName(ctx, "feat/ok");
  });
  test("the worktree holding a branch is found", () => {
    expect(findGitWorktree(ctx, clone, "feat/y")).toBe(linked);
    expect(findGitWorktree(ctx, clone, "feat/none")).toBeNull();
  });
});
