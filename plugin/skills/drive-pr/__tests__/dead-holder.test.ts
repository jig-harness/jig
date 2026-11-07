/**
 * dead-holder.test.ts — a driver confirmed gone with nothing left to save:
 * the doctor's `DEAD` verdict over plain inputs, and `worktreeVanished`, the
 * read that tells a tree that no longer exists from one that cannot be
 * inspected.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  byPlatform,
  skipsOnWindows,
} from "../../../../lib/test-helpers/windows-skip.ts";
import {
  classifyDrive,
  type DoctorInput,
  STALL_THRESHOLD_MIN_DEFAULT,
} from "../scripts/lib/doctor.ts";
import {
  gatherWorktreeLeftovers,
  worktreeVanished,
} from "../scripts/lib/leftovers.ts";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const TREE = "/tmp/gone-worktree";

/** A stale lock whose holder is gone, its tree unreadable and vanished. */
function deadInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    lockState: "stale",
    holderGone: true,
    treeVanished: true,
    progressAgeMs: 60_000,
    stateReadable: true,
    passChild: null,
    quotaPark: null,
    parkedCount: 0,
    leftovers: null,
    stallThresholdMs: STALL_THRESHOLD_MIN_DEFAULT * 60_000,
    pr: "4242",
    worktreePath: TREE,
    selfPath: "/abs/path/to/drives.ts",
    hostIsLocal: true,
    ...overrides,
  };
}

describe("classifyDrive — a dead holder with nothing left to save", () => {
  it("is DEAD when its process is gone and its tree no longer exists, naming the tree", () => {
    const row = classifyDrive(deadInput(), NOW);
    expect(row.verdict).toBe("DEAD");
    expect(row.reason).toContain(`${TREE} no longer exists`);
    expect(row.reason).toContain("shared Git storage");
  });

  it("is DEAD when its process is gone and its tree is clean", () => {
    const row = classifyDrive(
      deadInput({
        treeVanished: false,
        leftovers: { uncommitted: false, unpushed: false, unconcludedOp: null },
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD");
  });

  it("stays DEAD_WITH_LEFTOVERS when its tree still holds work", () => {
    const row = classifyDrive(
      deadInput({
        treeVanished: false,
        leftovers: { uncommitted: false, unpushed: true, unconcludedOp: null },
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD_WITH_LEFTOVERS");
  });

  it("stays UNKNOWN for a tree that exists but could not be inspected", () => {
    const row = classifyDrive(deadInput({ treeVanished: false }), NOW);
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toContain("could not be inspected");
  });

  it("stays UNKNOWN for a vanished tree whose process is not confirmed gone", () => {
    const row = classifyDrive(deadInput({ holderGone: false }), NOW);
    expect(row.verdict).toBe("UNKNOWN");
  });

  it("never reads a live lock as DEAD", () => {
    const row = classifyDrive(
      deadInput({ lockState: "live", passChild: true }),
      NOW,
    );
    expect(row.verdict).toBe("HEALTHY");
  });

  it("outranks a quota park the dead driver recorded", () => {
    const row = classifyDrive(
      deadInput({
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: "2026-09-12T15:00:00.000Z",
          at: "2026-09-12T10:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD");
  });
});

describe("worktreeVanished", () => {
  const scratch = mkdtempSync(join(tmpdir(), "jig-dead-holder-"));
  afterAll(() => {
    chmodSync(scratch, 0o755);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("is true for a directory that no longer exists", async () => {
    expect(await worktreeVanished(join(scratch, "deleted-tree"))).toBe(true);
  });

  it("is false for an existing directory git does not list as a worktree", async () => {
    const stray = join(scratch, "stray");
    mkdirSync(stray);
    expect(await worktreeVanished(stray)).toBe(false);
  });

  it("is false for an existing directory with unusual path characters", async () => {
    const name = byPlatform("Windows forbids newlines in path components", {
      windows: "tree with spaces",
      posix: "tree\nwith-newline",
    });
    const tree = join(scratch, name);
    mkdirSync(tree);
    expect(await worktreeVanished(tree)).toBe(false);
  });

  it("keeps an uninspectable tree with working files UNKNOWN", async () => {
    const tree = join(scratch, "missing-registration");
    mkdirSync(tree);
    writeFileSync(
      join(tree, ".git"),
      `gitdir: ${join(scratch, "missing-admin")}\n`,
    );
    writeFileSync(join(tree, "local.txt"), "recoverable working files\n");
    const leftovers = await gatherWorktreeLeftovers(tree);
    expect(leftovers).toBeNull();
    const treeVanished = await worktreeVanished(tree);
    expect(treeVanished).toBe(false);
    expect(
      classifyDrive(deadInput({ leftovers, treeVanished }), NOW).verdict,
    ).toBe("UNKNOWN");
  });

  it("is false for a worktree git lists", async () => {
    expect(await worktreeVanished(process.cwd())).toBe(false);
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "chmod cannot deny directory access on Windows",
    ) || process.getuid?.() === 0,
  )("is false for a path that cannot be read", async () => {
    const locked = join(scratch, "locked");
    mkdirSync(join(locked, "tree"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(await worktreeVanished(join(locked, "tree"))).toBe(false);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
