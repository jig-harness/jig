/**
 * attach-pr.ts run by a pass of the drive that holds the tree: the locks are
 * its own driver's, which attached the tree at its start, so a plain attach
 * attaches as the driver's would, and `--place`, the arm step's, tells the
 * pass it is a pass rather than meeting its own driver as a rival.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type Clone, makeClone, worktreeLock } from "./attach-pr-fixtures.ts";
import { putLock } from "./state-rows.ts";

const clones: Clone[] = [];
afterAll(() => {
  for (const c of clones) rmSync(c.root, { recursive: true, force: true });
});

const STARTED = "2026-11-05T09:37:50.000Z";

/** A tree whose tree lock and PR #42's lock this test process holds as a driver started at `STARTED`. */
function driven(): { c: Clone; tree: string } {
  const c = makeClone();
  clones.push(c);
  const tree = c.tree("wt1");
  const state = c.env.DRIVE_PR_STATE_DIR as string;
  const diag = {
    pr: "42",
    worktree: tree,
    log: "",
    started: STARTED,
    account: { account: null, vendor: null, provenance: "p", reason: "r" },
    generation: 1,
  };
  for (const name of [worktreeLock(c, tree), "pr-drive-42"])
    putLock(state, name, { token: "live0001", diag });
  return { c, tree };
}

/** The environment `drive.ts` hands its pass: the session, its acquisition and its target. */
function asPass(c: Clone, started = STARTED): void {
  c.env.DRIVE_PR_SESSION = String(process.pid);
  c.env.DRIVE_PR_SESSION_STARTED = started;
  c.env.DRIVE_PR_TARGET = "42";
}

describe("attach-pr.ts in a pass of the drive that holds the tree", () => {
  test("attaches, as its driver's attach does", () => {
    const { c, tree } = driven();
    asPass(c);
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 0, "attach");
    expect(JSON.parse(r.stdout)).toMatchObject({ pr: "42", head: c.head });
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(c.head);
  });

  test("still refuses a driver that is not its own", () => {
    const { c, tree } = driven();
    asPass(c, "2026-11-05T08:00:00.000Z");
    const r = c.attach(tree, "42");
    expectSpawnExit(r, 11, "attach");
    expect(r.stderr).toContain("holds this working tree");
  });

  test("--place says it is a pass of the drive, and moves nothing", () => {
    const { c, tree } = driven();
    asPass(c);
    const before = c.git(tree, "rev-parse", "HEAD");
    const r = c.attach(tree, "42", "--place");
    expectSpawnExit(r, 4, "attach --place");
    expect(r.stderr).toContain("a pass of the running drive of PR #42");
    expect(r.stderr).toContain("§ Driver pass");
    expect(c.git(tree, "rev-parse", "HEAD")).toBe(before);
  });
});
