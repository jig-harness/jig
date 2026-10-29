/**
 * destinationEnv: the environment of a process placement starts in another
 * tree keeps nothing that selects a repository, configuration, working tree
 * or drive state unless it names that tree.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AttachRefusal } from "../scripts/lib/attach.ts";
import { applyEnv, destinationEnv } from "../scripts/lib/attach-place.ts";
import { defaultStateRoot } from "../scripts/lib/state/store.ts";

const TREE = "/nonexistent/tree";
const DRIVE = {
  DRIVE_PR_WORKTREE: "/nonexistent/other",
  DRIVE_PR_TARGET: "7",
  DRIVE_PR_SESSION: "1",
  DRIVE_PR_SESSION_STARTED: "t",
};
const DRIVE_NAMES = Object.keys(DRIVE);

describe("destinationEnv", () => {
  test("removes only GH_REPO from a session outside any drive", () => {
    const change = destinationEnv(TREE, false, {
      GH_REPO: "example/app",
      JIG_OVERLAY: "/o.yaml",
      DRIVE_PR_STATE_DIR: "/state",
    });
    expect(change).toEqual({ unset: ["GH_REPO"] });
  });

  test("is empty when nothing selects another repository or tree", () => {
    expect(destinationEnv(TREE, false, { HOME: "/h" })).toEqual({ unset: [] });
  });

  test("keeps a drive's variables that name the same tree", () => {
    const change = destinationEnv(TREE, false, {
      ...DRIVE,
      DRIVE_PR_WORKTREE: TREE,
    });
    expect(change.unset).toEqual([]);
  });

  test("removes a drive's variables that name another tree, keeping its clone's state", () => {
    const change = destinationEnv(TREE, false, {
      ...DRIVE,
      DRIVE_PR_STATE_DIR: "/relocated/key",
      DRIVE_PR_STATE_DIR_IDENTITY: "1:2",
    });
    expect(change.unset).toEqual(DRIVE_NAMES);
  });

  test("in another clone, removes the configuration selectors and a default state leaf", () => {
    const change = destinationEnv(
      TREE,
      true,
      {
        ...DRIVE,
        JIG_CONSUMER_ROOT: "/here",
        JIG_OVERLAY: "/here/o.yaml",
        DRIVE_PR_STATE_DIR: join(defaultStateRoot(), "source-key"),
        DRIVE_PR_STATE_DIR_IDENTITY: "1:2",
      },
      "destination-key",
    );
    expect(change.unset).toEqual([
      ...DRIVE_NAMES,
      "JIG_CONSUMER_ROOT",
      "JIG_OVERLAY",
      "DRIVE_PR_STATE_DIR",
      "DRIVE_PR_STATE_DIR_IDENTITY",
    ]);
  });

  test("in another clone, keeps a state leaf that is the destination's", () => {
    const change = destinationEnv(
      TREE,
      true,
      {
        DRIVE_PR_STATE_DIR: "/relocated/destination-key",
        DRIVE_PR_STATE_DIR_IDENTITY: "1:2",
      },
      "destination-key",
    );
    expect(change.unset).toEqual([]);
  });

  test("in another clone, refuses a driver's state leaf under a relocated root", () => {
    expect(() =>
      destinationEnv(
        TREE,
        true,
        {
          DRIVE_PR_STATE_DIR: "/relocated/source-key",
          DRIVE_PR_STATE_DIR_IDENTITY: "1:2",
        },
        "destination-key",
      ),
    ).toThrow(AttachRefusal);
  });

  test("applyEnv removes what the change names", () => {
    expect(
      applyEnv({ GH_REPO: "x", KEEP: "1" }, { unset: ["GH_REPO"] }),
    ).toEqual({ KEEP: "1" });
  });
});
