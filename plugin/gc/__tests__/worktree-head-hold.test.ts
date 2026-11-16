/**
 * Holding a worktree's HEAD through its removal: while held, git refuses to
 * move the head, on a branch or detached; a lock git already holds keeps the
 * tree; under a ref store where `HEAD.lock` holds nothing a tree is kept,
 * detached or on a branch; and a release deletes only the lock
 * the hold wrote.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitEnvironment } from "../git.ts";
import { headHoldRefusal, holdHead } from "../kinds/worktree-head-hold.ts";
import { worktreeIdentity } from "../kinds/worktree-proof.ts";

const made: string[] = [];
afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], exit = 0) {
  const result = Bun.spawnSync(
    ["git", "-c", "user.email=t@example.invalid", "-c", "user.name=T", ...args],
    { cwd, env: gitEnvironment(), stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, exit);
  return result;
}

/** A repository with one commit and a worktree of it, detached unless `branch` is named. */
function setup(init: string[] = [], branch?: string) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gc-hold-")));
  made.push(root);
  const repo = join(root, "repo");
  const tree = join(root, "tree");
  git(root, ["init", "-q", ...init, repo]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
  git(repo, [
    "worktree",
    "add",
    "-q",
    ...(branch === undefined ? ["--detach"] : ["-b", branch]),
    tree,
  ]);
  return { repo, tree };
}

async function identity(tree: string) {
  const seen = await worktreeIdentity(tree);
  if (!seen.ok) throw new Error(seen.failure.reason);
  return seen.value;
}

describe("holding a worktree's head", () => {
  test("while held, git refuses a commit on it; the release frees it", async () => {
    const { tree } = setup();
    const seen = await identity(tree);
    const held = await holdHead(tree, seen);
    if (!held.ok) throw new Error(held.failure.reason);
    const lock = join(seen.admin, "HEAD.lock");
    expect(readFileSync(lock, "utf8")).toStartWith(`jig gc ${process.pid} `);
    const refused = git(tree, ["commit", "--allow-empty", "-m", "late"], 128);
    expect(refused.stderr.toString()).toContain("cannot lock ref 'HEAD'");
    expect(held.value.release()).toEqual({ ok: true, value: undefined });
    expect(existsSync(lock)).toBe(false);
    git(tree, ["commit", "-q", "--allow-empty", "-m", "late"]);
  });

  test("a tree on a branch is held too: git refuses to detach its head", async () => {
    const { tree } = setup([], "topic");
    const seen = await identity(tree);
    const held = await holdHead(tree, seen);
    if (!held.ok) throw new Error(held.failure.reason);
    const refused = git(tree, ["switch", "--detach"], 128);
    expect(refused.stderr.toString()).toContain("HEAD.lock");
    expect(held.value.release().ok).toBe(true);
  });

  test("a lock git already holds keeps the tree, and is left in place", async () => {
    const { tree } = setup();
    const seen = await identity(tree);
    const lock = join(seen.admin, "HEAD.lock");
    writeFileSync(lock, "git's own\n");
    const held = await holdHead(tree, seen);
    expect(held).toMatchObject({
      ok: false,
      failure: {
        code: "head-unheld",
        reason: expect.stringContaining("HEAD.lock exists"),
      },
    });
    expect(readFileSync(lock, "utf8")).toBe("git's own\n");
  });

  test("a release leaves a lock another process wrote after the hold's", async () => {
    const { tree } = setup();
    const seen = await identity(tree);
    const held = await holdHead(tree, seen);
    if (!held.ok) throw new Error(held.failure.reason);
    const lock = join(seen.admin, "HEAD.lock");
    writeFileSync(lock, "another\n");
    expect(held.value.release().ok).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe("another\n");
  });

  test("a short write keeps the tree and removes the lock it created", async () => {
    const { tree } = setup();
    const seen = await identity(tree);
    const held = await holdHead(tree, seen, () => 3);
    expect(held).toMatchObject({
      ok: false,
      failure: {
        code: "head-unheld",
        reason: expect.stringContaining("wrote 3 of"),
      },
    });
    expect(existsSync(join(seen.admin, "HEAD.lock"))).toBe(false);
  });

  test("a release after the git directory went is a success", async () => {
    const { repo, tree } = setup();
    const seen = await identity(tree);
    const held = await holdHead(tree, seen);
    if (!held.ok) throw new Error(held.failure.reason);
    git(repo, ["worktree", "remove", tree]);
    expect(existsSync(seen.admin)).toBe(false);
    expect(held.value.release().ok).toBe(true);
  });

  const probe = mkdtempSync(join(tmpdir(), "gc-hold-probe-"));
  made.push(probe);
  const reftable =
    Bun.spawnSync(["git", "init", "-q", "--ref-format=reftable", "--bare"], {
      cwd: probe,
      env: gitEnvironment(),
    }).exitCode === 0;
  test.skipIf(!reftable)(
    "a repository keeping its refs in reftable keeps every tree, detached or on a branch",
    async () => {
      for (const branch of ["topic", undefined]) {
        const { tree } = setup(["--ref-format=reftable"], branch);
        const seen = await identity(tree);
        expect(await headHoldRefusal(tree)).toEqual({
          ok: true,
          value: expect.stringContaining("reftable ref store"),
        });
        const held = await holdHead(tree, seen);
        expect(held).toMatchObject({
          ok: false,
          failure: {
            code: "head-unheld",
            reason: expect.stringContaining("reftable ref store"),
          },
        });
        expect(existsSync(join(seen.admin, "HEAD.lock"))).toBe(false);
      }
    },
  );
  test.skipIf(!reftable)(
    "a worktree's own config naming the files store does not hide a reftable repository",
    async () => {
      const { repo, tree } = setup(["--ref-format=reftable"]);
      git(repo, ["config", "extensions.worktreeConfig", "true"]);
      git(tree, ["config", "--worktree", "extensions.refStorage", "files"]);
      expect(await headHoldRefusal(tree)).toEqual({
        ok: true,
        value: expect.stringContaining("reftable ref store"),
      });
    },
  );
});
