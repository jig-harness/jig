/**
 * clone-key.test.ts — the per-clone identity `resolveStateDir`
 * hashes into its default state-dir path. Not a hash of `--git-common-dir`
 * itself (a path-derived key would silently change on a rename or
 * relocation — see `clone-key.ts`'s own module doc): `cloneKey` hashes a
 * persisted random UUID (`persistedCloneId`) that lives INSIDE
 * `--git-common-dir` and moves with it.
 *
 * Pins the property that actually matters for a state-dir default: two
 * clones never collide, one clone always resolves to the same key regardless
 * of which symlinked path it was reached through (or after a rename), and
 * the output is the filename-safe shape a path segment requires.
 */

import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneKey, peekCloneKey } from "../scripts/lib/state/clone-key.ts";
import { createExclusiveDurable } from "../scripts/lib/state/fsutil.ts";

describe("cloneKey", () => {
  it("is deterministic for the same path", () => {
    const dir = mkdtempSync(join(tmpdir(), "clone-key-a-"));
    try {
      expect(cloneKey(dir)).toBe(cloneKey(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("differs between two distinct clones", () => {
    const dirA = mkdtempSync(join(tmpdir(), "clone-key-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "clone-key-b-"));
    try {
      expect(cloneKey(dirA)).not.toBe(cloneKey(dirB));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("is 16 lowercase hex characters — the same truncation actor.ts’s worktreeKey uses", () => {
    const dir = mkdtempSync(join(tmpdir(), "clone-key-shape-"));
    try {
      expect(cloneKey(dir)).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves identically through a symlink hop to the same directory", () => {
    // The exact edge case actor.ts's worktreeKey doc comment already flags:
    // two paths that differ only by a symlink hop must hash as ONE clone, or
    // a checkout reached via two routes silently splits its state dir.
    const real = mkdtempSync(join(tmpdir(), "clone-key-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "clone-key-link-"));
    const link = join(linkParent, "alias");
    symlinkSync(real, link);
    try {
      expect(cloneKey(link)).toBe(cloneKey(real));
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it("survives a rename/relocation of the checkout — the identity moves WITH the directory, not with its path", () => {
    // The exact gap a pure realpath(commonDir) hash could not close
    // (docomply-review, a reference-implementation pull request): the directory's CONTENTS carry the
    // identity, so renaming or moving it must not mint a fresh key.
    const parent = mkdtempSync(join(tmpdir(), "clone-key-reloc-"));
    const original = join(parent, "original");
    mkdirSync(original);
    try {
      const before = cloneKey(original);
      const moved = join(parent, "moved");
      renameSync(original, moved);
      expect(cloneKey(moved)).toBe(before);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("adopts an already-persisted id rather than minting a new one — the race-safety property the exclusive, durable create provides", () => {
    // Simulates the losing side of a concurrent mint: another process (or
    // an earlier call) already won the `wx` create and its id is on disk.
    // `cloneKey` must hash THAT value, never generate and use its own
    // (docomply-review, a reference-implementation pull request — the whole point of routing the write
    // through `createExclusiveDurable` instead of a bare `writeFileSync`).
    const dir = mkdtempSync(join(tmpdir(), "clone-key-race-"));
    try {
      createExclusiveDurable(
        join(dir, "drive-pr-clone-id"),
        "11111111-1111-4111-8111-111111111111\n",
      );
      const expected = createHash("sha256")
        .update("11111111-1111-4111-8111-111111111111")
        .digest("hex")
        .slice(0, 16);
      expect(cloneKey(dir)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts a genuinely raced value — the publishing link itself lost, so this call never owned the file", async () => {
    // The EEXIST-vs-own-failure split this round's fix depends on
    // (docomply-review, a reference-implementation pull request round 3): when the publishing
    // `linkSync(tmp, path)` itself throws EEXIST, this call never created
    // `path`, so a re-read finds only a real racer's committed value, never
    // this call's own leftover. Modelled by making `linkSync` deposit the
    // "other process"'s content and fail with EEXIST in the same instant,
    // since a real concurrent winner cannot otherwise be produced from one
    // synchronous test.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-eexist-race-"));
    const target = join(dir, "drive-pr-clone-id");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      linkSync: (existingPath: string, newPath: string) => {
        if (newPath === target) {
          realFs.writeFileSync(
            target,
            "22222222-2222-4222-8222-222222222222\n",
          );
          const err = new Error(
            "EEXIST: file already exists",
          ) as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        }
        return realFs.linkSync(existingPath, newPath);
      },
    }));

    try {
      const expected = createHash("sha256")
        .update("22222222-2222-4222-8222-222222222222")
        .digest("hex")
        .slice(0, 16);
      expect(cloneKey(dir)).toBe(expected);
    } finally {
      mock.module("node:fs", () => realFs);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to adopt its own failed publish, and leaves no target file behind, rather than silently reporting corrupt content as this clone’s identity", async () => {
    // The bug this round fixes: a durability failure on this call's OWN
    // temp file (write/fsync/close, before the publishing link is ever
    // attempted) used to leave a file this call itself wrote at the FINAL
    // path, and the old code re-read and returned it anyway. Publishing via
    // link from an already-complete temp file means the target is never
    // touched by this call at all when the failure happens this early —
    // there is nothing of this call's own to remove, and nothing to adopt
    // either (docomply-review, a reference-implementation pull request round 3).
    const dir = mkdtempSync(join(tmpdir(), "clone-key-own-fail-"));
    const target = join(dir, "drive-pr-clone-id");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      fsyncSync: () => {
        throw new Error("simulated fsync failure");
      },
    }));

    try {
      expect(() => cloneKey(dir)).toThrow();
      expect(existsSync(target)).toBe(false);
    } finally {
      mock.module("node:fs", () => realFs);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to trust its own publish when the post-link directory fsync fails, rather than treating it as a raced winner", async () => {
    // The gap this closes (docomply-review, a reference-implementation pull request round 4): when
    // `createExclusiveDurable`'s publishing `link` succeeds but the
    // FOLLOWING directory fsync then fails, the old code here caught
    // whatever `createExclusiveDurable` threw, re-read the target — which
    // now has THIS call's own just-linked content — and returned it as if
    // another process had won a genuine race. `cloneKey` must instead
    // refuse outright, since this call cannot vouch for the directory
    // entry's durability and no racing winner is actually involved.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-dirfsync-fail-"));
    const target = join(dir, "drive-pr-clone-id");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFsyncSync = actualFs.fsyncSync;
    const realFs = { ...actualFs };

    let dirFd = -1;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        const fd = realOpenSync(path, flags);
        if (path === dir && flags === "r") dirFd = fd;
        return fd;
      },
      fsyncSync: (fd: number) => {
        if (fd === dirFd) throw new Error("simulated directory fsync failure");
        return realFsyncSync(fd);
      },
    }));

    try {
      expect(() => cloneKey(dir)).toThrow();
      // The link already landed — this call's own content is really there —
      // so refusing must not have deleted it out from under a later retry.
      expect(existsSync(target)).toBe(true);
    } finally {
      mock.module("node:fs", () => realFs);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never exposes the target file before its content is complete — the write lands on a temp path, not the target", async () => {
    // The chatgpt-codex-connector finding this round also fixes (PR #4618
    // round 3): the earlier direct-`wx`-on-target implementation created
    // the target's own directory entry BEFORE writing any content to it,
    // so a concurrent reader losing its own `wx` attempt in that window
    // could see the target exist but empty, or exist but truncated.
    // Publishing via an exclusive link from an already-complete temp file
    // closes the window structurally: the target has no state between
    // "absent" and "fully written". Verified here by checking the target
    // does not exist yet at the moment content is actually being written.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-no-partial-"));
    const target = join(dir, "drive-pr-clone-id");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    let targetExistedDuringWrite: boolean | undefined;
    mock.module("node:fs", () => ({
      ...realFs,
      writeSync: (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
      ) => {
        if (targetExistedDuringWrite === undefined) {
          targetExistedDuringWrite = realFs.existsSync(target);
        }
        return realFs.writeSync(fd, buffer, offset, length);
      },
    }));

    try {
      cloneKey(dir);
      expect(targetExistedDuringWrite).toBe(false);
    } finally {
      mock.module("node:fs", () => realFs);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a corrupted (non-UUID) persisted identity rather than silently hashing it", () => {
    // docomply-review, a reference-implementation pull request round 5: `readCloneId` used to accept every
    // nonempty string, though the only production minting path is
    // `randomUUID()`. A truncated or otherwise corrupted id file would
    // silently hash the surviving bytes into a DIFFERENT, valid-looking
    // state directory, abandoning this clone's parked decisions and round
    // budget under the original key with no error anywhere.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-corrupt-"));
    try {
      createExclusiveDurable(join(dir, "drive-pr-clone-id"), "not-a-uuid\n");
      expect(() => cloneKey(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a truncated persisted identity — a corrupted prefix of a real UUID is still nonempty", () => {
    const dir = mkdtempSync(join(tmpdir(), "clone-key-truncated-"));
    try {
      createExclusiveDurable(
        join(dir, "drive-pr-clone-id"),
        "3f9a2b1c-88", // a UUID cut off mid-write
      );
      expect(() => cloneKey(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a well-formed non-v4, non-RFC-4122-variant UUID — syntactically generic but impossible for randomUUID() to mint", () => {
    // docomply-review, a reference-implementation pull request round 12: the 8-4-4-4-12 hex shape alone
    // accepts a UUID no production writer could ever have produced —
    // randomUUID() always sets the version nibble to `4` and the variant
    // nibble to one of `8`/`9`/`a`/`b`. Every nibble `1` clears both.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-non-v4-"));
    try {
      createExclusiveDurable(
        join(dir, "drive-pr-clone-id"),
        "11111111-1111-1111-1111-111111111111\n",
      );
      expect(() => cloneKey(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an uppercase-recased UUID — randomUUID() only ever persists lowercase", () => {
    // docomply-review, a reference-implementation pull request round 13: hashCloneId() hashes case-
    // sensitively, so accepting uppercase would hash an otherwise-valid,
    // re-cased id to a DIFFERENT state-directory key than the one this
    // clone's real (lowercase) identity already resolved to.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-uppercase-"));
    try {
      createExclusiveDurable(
        join(dir, "drive-pr-clone-id"),
        "4C1D2E3F-1A2B-4C3D-8E4F-0123456789AB\n",
      );
      expect(() => cloneKey(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("peekCloneKey", () => {
  it("returns null when no identity is persisted yet, without minting one", () => {
    const dir = mkdtempSync(join(tmpdir(), "clone-key-peek-none-"));
    try {
      expect(peekCloneKey(dir)).toBeNull();
      expect(existsSync(join(dir, "drive-pr-clone-id"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the same hash cloneKey would, once an identity is persisted", () => {
    const dir = mkdtempSync(join(tmpdir(), "clone-key-peek-hit-"));
    try {
      const minted = cloneKey(dir);
      expect(peekCloneKey(dir)).toBe(minted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("also refuses a corrupted persisted identity, rather than reporting it as unminted", () => {
    // The dry-run preview path (migrate-legacy-state.ts) must not read
    // corruption as "nothing to migrate yet" — that would hide exactly the
    // failure this validation exists to surface.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-peek-corrupt-"));
    try {
      createExclusiveDurable(join(dir, "drive-pr-clone-id"), "garbage\n");
      expect(() => peekCloneKey(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty persisted identity file rather than reporting it as unminted", () => {
    // chatgpt-codex-connector, a reference-implementation pull request round 7: only ENOENT means "never
    // minted". A zero-byte file (a truncated write) is not that — treating
    // it as unminted would let the standalone fence's legacy fallback
    // inspect the obsolete legacy directory instead of the real one,
    // missing an active lease actually held under the real identity.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-peek-empty-"));
    try {
      createExclusiveDurable(join(dir, "drive-pr-clone-id"), "");
      expect(() => peekCloneKey(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a persisted identity it cannot read (not ENOENT) rather than reporting it as unminted", () => {
    // Same finding: a non-ENOENT read failure (permission, I/O, or here —
    // the id path reappearing as a directory) is not evidence of "never
    // minted" either, and must fail closed rather than silently resolve as
    // though this clone had no identity yet.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-peek-unreadable-"));
    try {
      mkdirSync(join(dir, "drive-pr-clone-id"));
      expect(() => peekCloneKey(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still returns null for a genuinely absent identity (ENOENT), not just missing the whole dir", () => {
    // Distinguishes "the file itself was never created" from the two
    // failures above — the one case that legitimately stays null.
    const dir = mkdtempSync(join(tmpdir(), "clone-key-peek-enoent-"));
    try {
      expect(peekCloneKey(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
