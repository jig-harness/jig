/**
 * `drivenBranch` in the drive state: optional, so a state written before the
 * field existed still reads; well-formed when present, so a record no reader
 * can use is refused like every other malformed field.
 */
import { describe, expect, test } from "bun:test";
import { parseDrivenTree } from "../../../shared/driven-tree.ts";
import { freshState, isUsableState } from "../scripts/lib/state/schema.ts";

const record = {
  branch: "feature/eng-1-probe",
  remote: "origin",
  worktree: "/work/trees/app-pr-7",
  detached: true,
  created: true,
  at: "2026-10-28T09:00:00.000Z",
};

describe("drivenBranch", () => {
  test("a fresh state carries it as null", () => {
    expect(freshState(7).drivenBranch).toBeNull();
    expect(isUsableState(freshState(7), 7)).toBe(true);
  });

  test("a state written before the field existed still reads", () => {
    const { drivenBranch: _, ...older } = freshState(7);
    expect(isUsableState(older, 7)).toBe(true);
  });

  test("a well-formed record reads", () => {
    expect(isUsableState({ ...freshState(7), drivenBranch: record }, 7)).toBe(
      true,
    );
  });

  test.each([
    ["a branch with a space", { branch: "two words" }],
    ["a refspec for a branch", { branch: "a:b" }],
    ["no remote", { remote: "" }],
    ["a worktree with a newline", { worktree: "/a\n/b" }],
    ["a missing created flag", { created: undefined }],
    ["an unreadable time", { at: "yesterday" }],
  ])("refuses %s", (_, change) => {
    const drivenBranch = { ...record, ...change };
    expect(isUsableState({ ...freshState(7), drivenBranch }, 7)).toBe(false);
  });

  test("the tree's own record refuses what the state refuses", () => {
    const tree = { pr: 7, branch: "feature", remote: "origin", created: false };
    expect(parseDrivenTree(JSON.stringify(tree))).toEqual(tree);
    expect(
      parseDrivenTree(JSON.stringify({ ...tree, branch: "a b" })),
    ).toBeNull();
    expect(parseDrivenTree(JSON.stringify({ ...tree, pr: 0 }))).toBeNull();
    expect(parseDrivenTree("not json")).toBeNull();
  });
});
