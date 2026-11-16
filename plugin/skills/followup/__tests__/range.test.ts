/**
 * The diff range a merge brought in, derived from the merge commit's
 * parents in a scratch repository: a squash merge and a merge commit, and a
 * preview's branch since it left its base.
 */
import { describe, expect, test } from "bun:test";
import { gitIdentityEnv, run } from "../../../shared/proc.ts";
import {
  changedFilesOf,
  type GitRunner,
  mergeRange,
  previewRange,
  type PrView,
  settleSquash,
} from "../scripts/lib/facts.ts";
import { scanDiff } from "../scripts/lib/scaffolding.ts";
import { gitRun, repository, write } from "./helpers.ts";

function runnerIn(root: string): GitRunner {
  return (args) =>
    run(["git", "-C", root, ...args], {
      timeoutSec: 30,
      env: gitIdentityEnv(),
    });
}

/** A repository whose `feature` branch adds `feature.ts` and edits `shared.ts` over two commits. */
function withFeature(): string {
  const root = repository({ "shared.ts": "export const a = 1;\n" });
  gitRun(root, "checkout", "-q", "-b", "feature");
  write(root, "feature.ts", "export const f = 1;\n");
  gitRun(root, "add", "-A");
  gitRun(root, "commit", "-qm", "add feature");
  write(root, "shared.ts", "export const a = 2;\n");
  gitRun(root, "commit", "-qam", "edit shared");
  gitRun(root, "checkout", "-q", "main");
  write(root, "main-only.ts", "export const m = 1;\n");
  gitRun(root, "add", "-A");
  gitRun(root, "commit", "-qm", "main moves on");
  return root;
}

describe("the range a merge brought in", () => {
  test("a squash merge: its one parent to the merge", async () => {
    const root = withFeature();
    const before = gitRun(root, "rev-parse", "HEAD");
    gitRun(root, "merge", "-q", "--squash", "feature");
    gitRun(root, "commit", "-qm", "feature (#7)");
    const merge = gitRun(root, "rev-parse", "HEAD");
    const range = await mergeRange(runnerIn(root), merge);
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(range.value).toEqual({ kind: "squash", base: before, head: merge });
    const files = await changedFilesOf(runnerIn(root), range.value);
    expect(files.ok && files.value.sort()).toEqual(["feature.ts", "shared.ts"]);
  });

  test("a merge commit: its first parent to the merge, the branch's head its second", async () => {
    const root = withFeature();
    const before = gitRun(root, "rev-parse", "HEAD");
    const branch = gitRun(root, "rev-parse", "feature");
    gitRun(
      root,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge feature (#7)",
      "feature",
    );
    const merge = gitRun(root, "rev-parse", "HEAD");
    const range = await mergeRange(runnerIn(root), merge);
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(range.value).toEqual({
      kind: "merge-commit",
      base: before,
      head: merge,
      branchHead: branch,
    });
    // The first parent already holds main's own commit: only the branch's files changed.
    const files = await changedFilesOf(runnerIn(root), range.value);
    expect(files.ok && files.value.sort()).toEqual(["feature.ts", "shared.ts"]);
  });

  test("a merge commit the clone does not hold is unreadable, not empty", async () => {
    const root = withFeature();
    const range = await mergeRange(runnerIn(root), "f".repeat(40));
    expect(range.ok).toBe(false);
  });

  test("a preview: the branch since it left its base", async () => {
    const root = withFeature();
    const fork = gitRun(root, "merge-base", "main", "feature");
    const head = gitRun(root, "rev-parse", "feature");
    const range = await previewRange(runnerIn(root), "main", head);
    expect(range.ok && range.value).toEqual({ kind: "open", base: fork, head });
  });
});

describe("a single-parent merge of several commits", () => {
  const viewOf = (
    commitSubjects: string[],
    files = ["feature.ts", "shared.ts"],
  ): PrView => ({ commitSubjects, files }) as unknown as PrView;

  test("a squash stays a squash although main moved after its parent", async () => {
    const root = withFeature();
    const before = gitRun(root, "rev-parse", "HEAD");
    gitRun(root, "merge", "-q", "--squash", "feature");
    gitRun(root, "commit", "-qm", "feature (#7)");
    const merge = gitRun(root, "rev-parse", "HEAD");
    const squash = { kind: "squash" as const, base: before, head: merge };
    const settled = await settleSquash(
      viewOf(["add feature", "edit shared"]),
      squash,
      runnerIn(root),
    );
    expect(settled).toEqual({ ok: true, value: squash });
  });

  test("a rebase reaches back over every landed commit, whatever files they touch", async () => {
    const root = withFeature();
    const before = gitRun(root, "rev-parse", "HEAD");
    gitRun(root, "cherry-pick", "feature~1", "feature");
    const merge = gitRun(root, "rev-parse", "HEAD");
    const squash = {
      kind: "squash" as const,
      base: gitRun(root, "rev-parse", "HEAD~1"),
      head: merge,
    };
    const settled = await settleSquash(
      viewOf(["add feature", "edit shared"]),
      squash,
      runnerIn(root),
    );
    expect(settled).toEqual({
      ok: true,
      value: { kind: "rebase", base: before, head: merge, branchHead: merge },
    });
  });
});

describe("a landed history that cannot be trusted", () => {
  const view = {
    commitSubjects: ["prepare", "finish"],
    files: ["b.ts"],
  } as unknown as PrView;

  test("a subject collision with an unrelated commit is ambiguous", async () => {
    const root = repository({ "a.ts": "1\n" });
    write(root, "unrelated.ts", "x\n");
    gitRun(root, "add", "-A");
    gitRun(root, "commit", "-qm", "prepare");
    write(root, "b.ts", "y\n");
    gitRun(root, "add", "-A");
    gitRun(root, "commit", "-qm", "finish");
    const merge = gitRun(root, "rev-parse", "HEAD");
    const settled = await settleSquash(
      view,
      {
        kind: "squash",
        base: gitRun(root, "rev-parse", "HEAD~1"),
        head: merge,
      },
      runnerIn(root),
    );
    expect(settled.ok).toBe(false);
  });

  test("an unreadable history is unreadable, not a squash", async () => {
    const root = repository({ "a.ts": "1\n" });
    const settled = await settleSquash(
      view,
      { kind: "squash", base: "a".repeat(40), head: "f".repeat(40) },
      runnerIn(root),
    );
    expect(settled.ok).toBe(false);
  });
});

describe("a rebase whose commits edit one file", () => {
  test("still reaches back over the first commit", async () => {
    const root = repository({ "a.test.ts": "test('a', () => {});\n" });
    gitRun(root, "checkout", "-q", "-b", "feature");
    write(root, "a.test.ts", "test.skip('a', () => {});\n");
    gitRun(root, "commit", "-qam", "skip a");
    write(root, "a.test.ts", "test.skip('a', () => {});\n// note\n");
    gitRun(root, "commit", "-qam", "annotate a");
    gitRun(root, "checkout", "-q", "main");
    const before = gitRun(root, "rev-parse", "HEAD");
    gitRun(root, "cherry-pick", "feature~1", "feature");
    const merge = gitRun(root, "rev-parse", "HEAD");
    const settled = await settleSquash(
      {
        commitSubjects: ["skip a", "annotate a"],
        files: ["a.test.ts"],
      } as unknown as PrView,
      {
        kind: "squash",
        base: gitRun(root, "rev-parse", "HEAD~1"),
        head: merge,
      },
      runnerIn(root),
    );
    expect(settled).toEqual({
      ok: true,
      value: { kind: "rebase", base: before, head: merge, branchHead: merge },
    });
  });
});

describe("the scaffolding scan", () => {
  test("names each added line that looks temporary, with its file and line", () => {
    const diff = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -3,0 +4,3 @@",
      "+test.only('works', () => {});",
      "+// eslint-disable-next-line no-console",
      "+const plain = 1;",
      "--- a/.github/workflows/ci.yml",
      "+++ b/.github/workflows/ci.yml",
      "@@ -10 +10 @@",
      "+    continue-on-error: true",
    ].join("\n");
    expect(scanDiff(diff).hits).toEqual([
      {
        kind: "focused test",
        file: "src/a.test.ts",
        line: 4,
        text: "test.only('works', () => {});",
      },
      {
        kind: "suppression",
        file: "src/a.test.ts",
        line: 5,
        text: "// eslint-disable-next-line no-console",
      },
      {
        kind: "gate turned off",
        file: ".github/workflows/ci.yml",
        line: 10,
        text: "continue-on-error: true",
      },
    ]);
  });
});
