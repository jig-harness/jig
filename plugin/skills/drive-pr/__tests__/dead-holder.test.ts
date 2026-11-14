/**
 * dead-holder.test.ts — a driver confirmed gone with nothing left to save:
 * the doctor's `DEAD` verdict over plain inputs, and the leftovers probe's
 * `missing`, the read that tells a tree that no longer exists from one that
 * cannot be inspected.
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
import { gatherWorktreeLeftovers } from "../scripts/lib/worktree-leftovers.ts";

const NOW = Temporal.Instant.from("2026-09-12T12:00:00.000Z");
const TREE = "/tmp/gone-worktree";

/** A stale lock whose holder is gone and whose tree is confirmed missing. */
function deadInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    lockState: "stale",
    processConfirmedGone: true,
    progressAgeMs: 60_000,
    stateReadable: true,
    passChild: null,
    quotaPark: null,
    parkedCount: 0,
    leftovers: "missing",
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
    expect(row.reason).toContain(`${TREE}) is missing`);
    expect(row.reason).toContain("shared Git storage");
  });

  it("is DEAD when its process is gone and its tree is clean", () => {
    const row = classifyDrive(
      deadInput({
        leftovers: { uncommitted: false, unpushed: false, unconcludedOp: null },
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD");
  });

  it("stays DEAD_WITH_LEFTOVERS when its tree still holds work", () => {
    const row = classifyDrive(
      deadInput({
        leftovers: { uncommitted: false, unpushed: true, unconcludedOp: null },
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD_WITH_LEFTOVERS");
  });

  it("stays UNKNOWN for a tree that exists but could not be inspected", () => {
    const row = classifyDrive(deadInput({ leftovers: null }), NOW);
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toContain("could not be inspected");
  });

  it("stays UNKNOWN for a vanished tree whose process is not confirmed gone", () => {
    const row = classifyDrive(deadInput({ processConfirmedGone: false }), NOW);
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

describe("gatherWorktreeLeftovers — a tree that is gone or cannot be read", () => {
  const scratch = mkdtempSync(join(tmpdir(), "jig-dead-holder-"));
  afterAll(() => {
    chmodSync(scratch, 0o755);
    rmSync(scratch, { recursive: true, force: true });
  });
  const probe = (tree: string) => gatherWorktreeLeftovers(tree, process.cwd());

  it("is missing for a directory that no longer exists", async () => {
    expect(await probe(join(scratch, "deleted-tree"))).toBe("missing");
  });

  it("is uninspectable for an existing directory git does not list as a worktree", async () => {
    const stray = join(scratch, "stray");
    mkdirSync(stray);
    expect(await probe(stray)).toBeNull();
  });

  it("is uninspectable for an existing directory with unusual path characters", async () => {
    const name = byPlatform("Windows forbids newlines in path components", {
      windows: "tree with spaces",
      posix: "tree\nwith-newline",
    });
    const tree = join(scratch, name);
    mkdirSync(tree);
    expect(await probe(tree)).toBeNull();
  });

  it("keeps an uninspectable tree with working files UNKNOWN", async () => {
    const tree = join(scratch, "missing-registration");
    mkdirSync(tree);
    writeFileSync(
      join(tree, ".git"),
      `gitdir: ${join(scratch, "missing-admin")}\n`,
    );
    writeFileSync(join(tree, "local.txt"), "recoverable working files\n");
    const leftovers = await probe(tree);
    expect(leftovers).toBeNull();
    expect(classifyDrive(deadInput({ leftovers }), NOW).verdict).toBe(
      "UNKNOWN",
    );
  });

  it("reads a worktree git lists", async () => {
    expect(await probe(process.cwd())).not.toBe("missing");
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "chmod cannot deny directory access on Windows",
    ) || process.getuid?.() === 0,
  )("is uninspectable for a path that cannot be read", async () => {
    const locked = join(scratch, "locked");
    mkdirSync(join(locked, "tree"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(await probe(join(locked, "tree"))).toBeNull();
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
