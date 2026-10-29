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
  readDrivenTree,
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
