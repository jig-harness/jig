/**
 * What the release arm reads, in a scratch repository: the merge's change
 * notes and whether each still waits on the integration branch, and the
 * status report read from a checkout that is removed whatever it did.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { gitIdentityEnv, run } from "../../../shared/proc.ts";
import type { GitRunner } from "../scripts/lib/facts.ts";
import {
  isNote,
  mergeNotes,
  statusInCheckout,
} from "../scripts/lib/release.ts";
import { gitRun, repository, write } from "./helpers.ts";

function runnerIn(root: string): GitRunner {
  return (args) =>
    run(["git", "-C", root, ...args], {
      timeoutSec: 30,
      env: gitIdentityEnv(),
    });
}

/** A repository whose last commit (the merge) adds a note and a source file. */
function merged(): { root: string; base: string; merge: string } {
  const root = repository({ "changes/README.md": "# Notes\n" });
  const base = gitRun(root, "rev-parse", "HEAD");
  write(root, "changes/keep-order.md", "---\nrelease: patch\n---\n");
  write(root, "changes/nested/skip.md", "not a note\n");
  write(root, "src/export.ts", "export const a = 1;\n");
  gitRun(root, "add", "-A");
  gitRun(root, "commit", "-qm", "keep order (#7)");
  return { root, base, merge: gitRun(root, "rev-parse", "HEAD") };
}

describe("the merge's notes", () => {
  test("a note is a Markdown file directly in the folder, not its README", () => {
    expect(isNote("changes/a.md", "changes")).toBe(true);
    expect(isNote("changes/README.md", "changes")).toBe(false);
    expect(isNote("changes/nested/a.md", "changes")).toBe(false);
    expect(isNote("docs/a.md", "changes")).toBe(false);
  });

  test("a note still on the integration branch waits; one a release removed does not", async () => {
    const { root, base, merge } = merged();
    const range = { kind: "squash" as const, base, head: merge };
    const before = await mergeNotes(runnerIn(root), range, "changes", "main");
    expect(before).toEqual({
      notes: [{ file: "changes/keep-order.md", waiting: true }],
      error: null,
    });
    gitRun(root, "rm", "-q", "changes/keep-order.md");
    gitRun(root, "commit", "-qm", "chore(release): 1.0.1");
    const after = await mergeNotes(runnerIn(root), range, "changes", "main");
    expect(after.notes).toEqual([
      { file: "changes/keep-order.md", waiting: false },
    ]);
  });
});

describe("the status report", () => {
  test("is read from a checkout of the integration branch, removed afterwards", async () => {
    const { root } = merged();
    let seen = "";
    const read = await statusInCheckout(runnerIn(root), "main", async (dir) => {
      seen = dir;
      return {
        code: 0,
        stdout: JSON.stringify({
          configured: true,
          releaseRun: { state: "none" },
        }),
        stderr: "",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false,
        stderrTail: "",
      };
    });
    expect(existsSync(`${seen}/changes/keep-order.md`)).toBe(false);
    expect(read).toMatchObject({ exit: 0, report: { configured: true } });
    expect(gitRun(root, "worktree", "list")).not.toContain(seen);
  });
});
