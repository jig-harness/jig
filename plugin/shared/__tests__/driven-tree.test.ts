/**
 * driven-tree.ts: a tree's record is replaced whole, so a failed write leaves
 * the record it replaced rather than an empty or partial one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIVEN_TREE_FILE,
  type DrivenTree,
  detachedTreeRecord,
  detachedTreeRecordSync,
  readDrivenTree,
  type TreeGitResult,
  writeDrivenTree,
} from "../driven-tree.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    chmodSync(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});
function gitDir(): string {
  const d = mkdtempSync(join(tmpdir(), "driven-tree-"));
  dirs.push(d);
  return d;
}

const record: DrivenTree = {
  pr: 7,
  branch: "feature",
  remote: "origin",
  created: true,
  head: "a".repeat(40),
};

describe("writeDrivenTree", () => {
  test("replaces the record and leaves nothing staged beside it", () => {
    const d = gitDir();
    writeDrivenTree(d, record);
    writeDrivenTree(d, { ...record, pr: 8 });
    expect(readDrivenTree(d)).toEqual({ ...record, pr: 8 });
    expect(readdirSync(d)).toEqual([DRIVEN_TREE_FILE]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the previous record when the write fails",
    () => {
      const d = gitDir();
      writeFileSync(join(d, DRIVEN_TREE_FILE), `${JSON.stringify(record)}\n`);
      chmodSync(d, 0o555);
      expect(() => writeDrivenTree(d, { ...record, pr: 9 })).toThrow();
      expect(readDrivenTree(d)).toEqual(record);
    },
  );
});

describe("the asynchronous and synchronous readers", () => {
  /** A detached tree with `record`, whose head the given remote refs hold. */
  function fakeGit(d: string, holders: string[]) {
    return (args: string[]): TreeGitResult => {
      const call = args.join(" ");
      if (call === "symbolic-ref --quiet HEAD") return { code: 1, stdout: "" };
      if (call === "rev-parse --absolute-git-dir")
        return { code: 0, stdout: `${d}\n` };
      if (call.startsWith("for-each-ref --contains HEAD"))
        return { code: 0, stdout: holders.map((r) => `${r}\n`).join("") };
      return { code: 0, stdout: "" };
    };
  }

  test.each([
    ["no remote branch holds the head", [], true],
    ["its own branch holds the head", ["refs/remotes/origin/feature"], true],
    [
      "another branch alone holds the head",
      ["refs/remotes/origin/stacked"],
      false,
    ],
  ])("agree when %s", async (_what, holders, describes) => {
    const d = gitDir();
    writeDrivenTree(d, record);
    const git = fakeGit(d, holders);
    const expected = describes ? record : null;
    expect(detachedTreeRecordSync(git)).toEqual(expected);
    expect(await detachedTreeRecord(async (args) => git(args))).toEqual(
      expected,
    );
  });
});
