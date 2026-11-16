/**
 * The head of a worktree Orca manages, held from gc's final comparison with
 * its proof through `orca worktree rm`: a commit in that window is refused,
 * one made before it keeps the worktree, and the hold stays while Orca's
 * answer leaves the removal unsettled. Runs `jig gc` against the fake `orca`
 * of `orca-fixture.ts`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import type { Receipt } from "../types.ts";
import {
  calls,
  commitAndPush,
  detachWithMergedPull,
  gc,
  idle,
  line,
  setup,
} from "./orca-fixture.ts";

/** A detached checkout whose head only a merged pull request holds, idle. */
function detachedAndIdle(): ReturnType<typeof setup> {
  const f = setup();
  commitAndPush(f, "work", { "work.txt": "work\n" });
  detachWithMergedPull(
    f,
    f.command(["git", "-C", f.tree, "rev-parse", "HEAD"]),
  );
  f.command(["git", "-C", f.tree, "push", "origin", "--delete", "topic"]);
  idle(f);
  return f;
}

/** The receipt line of a collection that exits 1. */
function failedLine(f: ReturnType<typeof setup>) {
  const result = gc(f, ["--collect", "--json"]);
  expectSpawnExit(result, 1);
  return (JSON.parse(result.stdout.toString()) as Receipt).resources[0];
}

describe.skipIf(
  skipsOnWindows(
    "git-bash",
    "the fixture remote is served through a shell script as the SSH command, and the remove hook is one",
  ),
)("the head of a worktree Orca manages", () => {
  test("a commit tried on a detached checkout while orca worktree rm runs is refused, so none is lost", () => {
    const f = detachedAndIdle();
    f.writeState({ commitAt: "rm" });
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "collected",
      reason: expect.stringContaining("orca worktree rm"),
    });
    const [code, ...error] = readFileSync(
      join(f.root, "window-commit"),
      "utf8",
    ).split("\n");
    expect(code).not.toBe("0");
    expect(error.join("\n")).toContain("HEAD.lock");
    expect(existsSync(f.tree)).toBe(false);
    expect(
      f.command(["git", "log", "--all", "--reflog", "--format=%s"]),
    ).not.toContain("window");
  }, 60_000);

  test("a detached checkout that gains a commit after the remove hook is kept, the commit with it", () => {
    const f = detachedAndIdle();
    f.writeState({ commitAt: "ps" });
    expect(failedLine(f)).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("Worktree identity changed"),
    });
    expect(readFileSync(join(f.root, "late-commit"), "utf8")).toBe("0");
    expect(existsSync(f.tree)).toBe(true);
    expect(f.command(["git", "-C", f.tree, "log", "-1", "--format=%s"])).toBe(
      "late",
    );
    expect(
      existsSync(join(f.repo, ".git", "worktrees", "topic", "HEAD.lock")),
    ).toBe(false);
    expect(calls(f)).not.toContainEqual(expect.stringMatching(/ rm /));
  }, 60_000);

  test("a detached checkout Orca is still deleting keeps its head held, and the next collection takes the hold over", () => {
    const f = detachedAndIdle();
    f.writeState({ rm: "accepted" });
    const pending = failedLine(f);
    expect(pending).toMatchObject({
      outcome: "failed",
      details: { claim: "kept" },
    });
    expect(String(pending?.reason)).toContain(
      "Orca is still deleting the checkout in the background",
    );
    expect(String(pending?.reason)).toContain("HEAD.lock in place");
    const lock = join(f.repo, ".git", "worktrees", "topic", "HEAD.lock");
    expect(readFileSync(lock, "utf8")).toStartWith("jig gc ");
    const tried = Bun.spawnSync(
      ["git", "-C", f.tree, "commit", "--allow-empty", "-m", "window"],
      { env: f.env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExitNot(tried, 0);
    expect(tried.stderr.toString()).toContain("HEAD.lock");
    // The worktree survived: the next collection takes the lock over and
    // asks Orca again.
    rmSync(join(f.root, "hook-ran"));
    f.writeState({});
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "collected",
    });
    expect(existsSync(join(f.root, "hook-ran"))).toBe(true);
    expect(existsSync(f.tree)).toBe(false);
  }, 60_000);

  test("Orca's refusal releases the hold", () => {
    const f = detachedAndIdle();
    f.writeState({ rm: "refused" });
    expect(failedLine(f)).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("worktree_dirty"),
    });
    expect(
      existsSync(join(f.repo, ".git", "worktrees", "topic", "HEAD.lock")),
    ).toBe(false);
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);

  test("a HEAD.lock gc did not write keeps the worktree before its hook runs", () => {
    const f = detachedAndIdle();
    const lock = join(f.repo, ".git", "worktrees", "topic", "HEAD.lock");
    writeFileSync(lock, "git's own\n");
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining(`${lock} exists`),
    });
    expect(existsSync(join(f.root, "hook-ran"))).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("git's own\n");
    expect(calls(f)).not.toContainEqual(expect.stringMatching(/ rm /));
  }, 60_000);
});
