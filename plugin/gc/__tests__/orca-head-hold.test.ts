/**
 * The head of a worktree Orca manages, held from gc's final comparison with
 * its proof through `orca worktree rm`: a commit in that window is refused,
 * one made before it keeps the worktree, and the hold stays while Orca's
 * answer leaves the removal unsettled, a later collection's included, and
 * when a step throws while the removal is unsettled. Runs `jig gc` against
 * the fake `orca` of `orca-fixture.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
function failedLine(
  f: ReturnType<typeof setup>,
  extraEnv: Record<string, string> = {},
) {
  const result = gc(f, ["--collect", "--json"], extraEnv);
  expectSpawnExit(result, 1);
  return (JSON.parse(result.stdout.toString()) as Receipt).resources[0];
}

/**
 * A checkout a collection that ended left unsettled: Orca answered that it
 * was still deleting it, so the run's `HEAD.lock` and its submitted launch
 * guard admission stay for the next collection to take over. The lock, the
 * text that run wrote in it, and the admission's file.
 */
function leftUnsettled(f: ReturnType<typeof setup>) {
  f.writeState({ rm: "accepted" });
  expect(failedLine(f)).toMatchObject({ details: { claim: "kept" } });
  const lock = join(f.repo, ".git", "worktrees", "topic", "HEAD.lock");
  const admission = join(
    f.guard,
    "admissions",
    `${createHash("sha256").update(f.tree).digest("hex")}.json`,
  );
  expect(readFileSync(admission, "utf8")).toContain('"submitted"');
  rmSync(join(f.root, "hook-ran"));
  return { lock, text: readFileSync(lock, "utf8"), admission };
}

/** Whether a commit tried in the checkout is refused for its held head. */
function commitRefused(f: ReturnType<typeof setup>): void {
  const tried = Bun.spawnSync(
    ["git", "-C", f.tree, "commit", "--allow-empty", "-m", "window"],
    { env: f.env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExitNot(tried, 0);
  expect(tried.stderr.toString()).toContain("HEAD.lock");
}

/**
 * A preload for the collecting `jig gc` that makes the removal's submit
 * step, the last before `orca worktree rm` and after the head is held,
 * throw: the first clock read from a frame named `submit`, the one that
 * dates the admission's submitted mark, fails. A named `node:fs` import does
 * not see a module patched at preload, so the throw is placed in a global
 * the step reads.
 */
function throwingSubmit(f: ReturnType<typeof setup>): Record<string, string> {
  const preload = join(f.root, "throwing-step.ts");
  writeFileSync(
    preload,
    `const instant = Temporal.Now.instant;
let thrown = false;
Temporal.Now.instant = () => {
  if (!thrown && /\\bat submit\\b/.test(new Error().stack ?? "")) {
    thrown = true;
    throw new Error("injected: the submit step threw");
  }
  return instant();
};
`,
  );
  return { BUN_OPTIONS: `--preload=${preload}` };
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

  test.each([
    ["answers that it is still deleting the checkout", "accepted"],
    ["refuses the call for a removal under way", "in-progress"],
  ] as const)(
    "a hold taken over from an ended run stays when Orca %s again",
    (_, rm) => {
      const f = detachedAndIdle();
      const left = leftUnsettled(f);
      f.writeState({ rm });
      const again = failedLine(f);
      expect(again).toMatchObject({
        outcome: "failed",
        details: { claim: "kept" },
      });
      expect(String(again?.reason)).toContain(
        "Orca is still deleting the checkout in the background",
      );
      expect(String(again?.reason)).toContain(`gc leaves ${left.lock}`);
      expect(existsSync(join(f.root, "hook-ran"))).toBe(true);
      // The lock still names the run that wrote it, which the next
      // collection takes over in turn.
      expect(readFileSync(left.lock, "utf8")).toBe(left.text);
      expect(left.text).toStartWith("jig gc ");
      expect(existsSync(left.admission)).toBe(true);
      commitRefused(f);
      expect(existsSync(f.tree)).toBe(true);
    },
    60_000,
  );

  test("a step that throws after a hold taken over from an ended run keeps the hold and the claim", () => {
    const f = detachedAndIdle();
    const left = leftUnsettled(f);
    f.writeState({});
    const thrown = failedLine(f, throwingSubmit(f));
    expect(thrown).toMatchObject({
      outcome: "failed",
      details: { claim: "kept" },
    });
    expect(String(thrown?.reason)).toContain("injected: the submit step threw");
    expect(String(thrown?.reason)).toContain(`gc leaves ${left.lock}`);
    expect(String(thrown?.reason)).toContain("the launch guard claim stays");
    // The hook ran, so the step that threw came after the head was held, and
    // before the call: only the ended run asked Orca to remove the checkout.
    expect(existsSync(join(f.root, "hook-ran"))).toBe(true);
    expect(calls(f).filter((call) => / rm /.test(call))).toHaveLength(1);
    expect(readFileSync(left.lock, "utf8")).toBe(left.text);
    expect(existsSync(left.admission)).toBe(true);
    commitRefused(f);
    expect(existsSync(f.tree)).toBe(true);
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
