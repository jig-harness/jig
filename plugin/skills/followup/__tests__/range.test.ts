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
  type PrView,
  previewRange,
  rebaseRange,
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

describe("a multi-commit pull request landed by rebase", () => {
  const viewOf = (commits: string[]): PrView => ({
    number: 7,
    url: "",
    title: "",
    state: "MERGED",
    mergeCommit: null,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "",
    body: "",
    labels: [],
    files: [],
    commits,
  });

  test("a squash of several commits keeps its first-parent range", async () => {
    const root = withFeature();
    const commits = gitRun(
      root,
      "rev-list",
      "--reverse",
      "main..feature",
    ).split("\n");
    gitRun(root, "merge", "-q", "--squash", "feature");
    gitRun(root, "commit", "-qm", "feature (#7)");
    const merge = gitRun(root, "rev-parse", "HEAD");
    const git = runnerIn(root);
    const read = await mergeRange(git, merge);
    if (!read.ok) throw new Error("unreadable");
    expect(await rebaseRange(viewOf(commits), merge, read.value, git)).toEqual({
      ok: true,
      value: read.value,
    });
  });

  test("a failed `git cherry` is unreadable, never the squash range", async () => {
    const root = withFeature();
    const commits = gitRun(
      root,
      "rev-list",
      "--reverse",
      "main..feature",
    ).split("\n");
    gitRun(root, "cherry-pick", ...commits);
    const merge = gitRun(root, "rev-parse", "HEAD");
    const git = runnerIn(root);
    const read = await mergeRange(git, merge);
    if (!read.ok) throw new Error("unreadable");
    const failing: typeof git = async (args) =>
      args[0] === "cherry"
        ? { ...(await git(["--version"])), code: 128, stdout: "" }
        : git(args);
    const out = await rebaseRange(viewOf(commits), merge, read.value, failing);
    expect(out.ok).toBe(false);
  });

  test("a rebase keeps the landed sequence: the base is below its first commit", async () => {
    const root = withFeature();
    const commits = gitRun(
      root,
      "rev-list",
      "--reverse",
      "main..feature",
    ).split("\n");
    const before = gitRun(root, "rev-parse", "HEAD");
    gitRun(root, "cherry-pick", ...commits);
    const merge = gitRun(root, "rev-parse", "HEAD");
    const git = runnerIn(root);
    const read = await mergeRange(git, merge);
    if (!read.ok) throw new Error("unreadable");
    const range = await rebaseRange(viewOf(commits), merge, read.value, git);
    expect(range).toEqual({
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
