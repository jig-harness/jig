/**
 * fsutil.test.ts — `lib/state/fsutil.ts`'s `atomicWrite`, `fsyncFileSync`
 * and `createExclusiveDurable`: the shared durable-write primitives used by
 * mailbox repair, leases, handoff, state storage, `clone-key.ts`'s
 * per-clone identity, and `migrate-legacy-state.ts`'s copy-verify-delete. See
 * each module's own header for the crash-safety reasoning
 * (fsync-before-rename / fsync-before-delete, fsync-directory-after);
 * these tests are the probes for it.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync as writeFileSyncReal,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWrite,
  createExclusiveDurable,
  ExclusiveDurabilityUnconfirmed,
  ExclusiveWriteOwnFailure,
  fsyncFileSync,
} from "../scripts/lib/state/fsutil.ts";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  // `mock.module` is process-global and never torn down automatically —
  // every test that installs one must restore the real module in its own
  // `finally`, mirroring `lock.test.ts`'s own established pattern for this
  // exact hazard.
});

describe("atomicWrite", () => {
  it("writes content that is readable at the target path afterward", () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-"));
    const target = join(dir, "file.json");
    atomicWrite(target, "hello world\n");
    expect(readFileSync(target, "utf8")).toBe("hello world\n");
  });

  it("leaves no temp file behind on a successful write", () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-"));
    const target = join(dir, "file.json");
    atomicWrite(target, "content\n");
    const leftovers = readdirSync(dir).filter((f) => f !== "file.json");
    expect(leftovers).toEqual([]);
  });

  it("cleans up the temp file when fsyncSync fails, rather than leaking it", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-fsync-fail-"));
    const target = join(dir, "file.json");

    // Modelled portably via `mock.module`, not a real fsync-hostile
    // filesystem (tmpfs on CI, APFS locally — neither reliably fails
    // fsync) — see `lock.test.ts`'s own identical rationale for this
    // pattern. `realFs` is snapshotted into a fresh plain object BEFORE
    // `mock.module` swaps the registry entry, so the `finally` restore
    // resolves through the real implementation rather than the
    // still-mocked one.
    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };

    mock.module("node:fs", () => ({
      ...realFs,
      fsyncSync: () => {
        throw new Error("simulated fsync failure");
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow(
        "simulated fsync failure",
      );
      // The target was never created (rename never ran)...
      expect(existsSync(target)).toBe(false);
      // ...and the temp file the exclusive open created before the fsync
      // attempt is gone too, not orphaned.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("does not undo a completed rename when the directory fsync is genuinely unsupported (ENOTSUP)", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-dirfsync-fail-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFsyncSync = actualFs.fsyncSync;
    const realFs = { ...actualFs };

    // Fail ONLY the directory's `fsyncSync` call, not its `openSync` (that one
    // must always succeed genuinely for this to test what it claims — the
    // allowlist applies solely to fsync, not open, so mocking the open here
    // would test the wrong operation). Tracked by fd rather than path, since
    // `fsyncSync` only receives the fd.
    let dirFd = -1;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        const fd = realOpenSync(path, flags);
        if (flags === "r" && path === dir) dirFd = fd;
        return fd;
      },
      fsyncSync: (fd: number) => {
        if (fd === dirFd) {
          const err = new Error(
            "simulated directory fsync failure",
          ) as NodeJS.ErrnoException;
          err.code = "ENOTSUP";
          throw err;
        }
        return realFsyncSync(fd);
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).not.toThrow();
      expect(readFileSync(target, "utf8")).toBe("content\n");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("does not undo a completed rename when the directory fsync is genuinely unsupported (EINVAL)", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-dirfsync-einval-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFsyncSync = actualFs.fsyncSync;
    const realFs = { ...actualFs };

    // POSIX also specifies EINVAL for "fsync not possible on this fd", which
    // some filesystems return for a directory descriptor instead of
    // ENOTSUP/EOPNOTSUPP, so allow-listing only those two would report a
    // valid write as failed on exactly this code. Targets
    // `fsyncSync` by fd, not `openSync` by path — see the ENOTSUP test's
    // comment for why.
    let dirFd = -1;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        const fd = realOpenSync(path, flags);
        if (flags === "r" && path === dir) dirFd = fd;
        return fd;
      },
      fsyncSync: (fd: number) => {
        if (fd === dirFd) {
          const err = new Error(
            "simulated directory fsync failure",
          ) as NodeJS.ErrnoException;
          err.code = "EINVAL";
          throw err;
        }
        return realFsyncSync(fd);
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).not.toThrow();
      expect(readFileSync(target, "utf8")).toBe("content\n");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("propagates a genuine directory-fsync durability failure (EIO) rather than reporting success", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-dirfsync-eio-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFsyncSync = actualFs.fsyncSync;
    const realFs = { ...actualFs };

    // EIO is a real durability signal, not an "unsupported operation" — an
    // earlier blanket catch swallowed this identically to ENOTSUP, which meant
    // `atomicWrite` could report success on a rename whose directory entry was
    // never actually made durable.
    let dirFd = -1;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        const fd = realOpenSync(path, flags);
        if (flags === "r" && path === dir) dirFd = fd;
        return fd;
      },
      fsyncSync: (fd: number) => {
        if (fd === dirFd) {
          const err = new Error(
            "simulated directory fsync failure",
          ) as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return realFsyncSync(fd);
      },
    }));

    try {
      // The rename itself already landed — this asserts the ERROR
      // propagates, not that the write was undone.
      expect(() => atomicWrite(target, "content\n")).toThrow(
        "simulated directory fsync failure",
      );
      expect(readFileSync(target, "utf8")).toBe("content\n");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("propagates a failure to even OPEN the directory, regardless of its error code, rather than misclassifying it as an unsupported fsync", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-diropen-einval-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFs = { ...actualFs };

    // The ENOTSUP/EOPNOTSUPP/EINVAL allowlist exists for "fsync is not
    // possible on this fd" — a statement about `fsyncSync`. An OPEN
    // failure carrying one of those same codes is a DIFFERENT problem
    // (fsync was never even attempted) and must not be swallowed by the
    // same allowlist, even though it shares a code with a case that
    // legitimately is.
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "r" && path === dir) {
          const err = new Error(
            "simulated directory open failure",
          ) as NodeJS.ErrnoException;
          err.code = "EINVAL";
          throw err;
        }
        return realOpenSync(path, flags);
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow(
        "simulated directory open failure",
      );
      // The rename itself already landed — asserts the ERROR propagates,
      // not that the write was undone.
      expect(readFileSync(target, "utf8")).toBe("content\n");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("preserves the primary write/fsync error over a close failure, rather than letting the close error replace it", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-close-masks-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFs = { ...actualFs };

    // A DOUBLE failure: the write itself fails (ENOSPC), and closing the
    // now-broken fd ALSO fails. Plain `try { ... } finally { closeSync(fd) }`
    // would let the close error overwrite the write error — hiding the
    // actual ENOSPC/EIO/durability failure behind an unrelated close
    // error.
    let tmpFd = -1;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        const fd = realOpenSync(path, flags);
        if (flags === "wx") tmpFd = fd;
        return fd;
      },
      writeSync: () => {
        throw new Error("PRIMARY: simulated ENOSPC mid-write");
      },
      closeSync: (fd: number) => {
        if (fd === tmpFd) {
          throw new Error("SECONDARY: simulated close failure");
        }
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow(/PRIMARY/);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("cleans up the temp file when writeSync fails after the exclusive open succeeded, rather than leaking it", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-writefail-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };

    // Simulates ENOSPC mid-write: the exclusive `openSync(tmp, 'wx')` has
    // already landed a real (empty) file on disk by the time this throws — the
    // case the cleanup region covers, exercised against the openSync+writeSync
    // implementation.
    mock.module("node:fs", () => ({
      ...realFs,
      writeSync: () => {
        throw new Error("simulated ENOSPC mid-write");
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow(
        "simulated ENOSPC mid-write",
      );
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("does not delete a colliding writer's live temp file on an EEXIST suffix collision", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-eexist-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realWriteFileSync = actualFs.writeFileSync;
    const realFs = { ...actualFs };

    let collidingPath = "";
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "wx") {
          collidingPath = path;
          // Simulate a concurrent writer's temp file already sitting at
          // this exact 24-bit-suffix path — the exclusive open then
          // fails with a GENUINE EEXIST from the real filesystem (not a
          // fabricated error), exactly as it would for a real collision.
          realWriteFileSync(path, "COLLIDING-WRITER-CONTENT", { flag: "w" });
        }
        return realOpenSync(path, flags);
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow();
      // This invocation never created `tmp` — ownership tracking (set the
      // instant `openSync(tmp, 'wx')` itself succeeds, not inferred from a
      // later error code) means the cleanup path must NOT unlink it, since
      // doing so would delete the colliding writer's own live temp file out
      // from under its in-flight write/fsync/rename.
      expect(existsSync(collidingPath)).toBe(true);
      expect(readFileSync(collidingPath, "utf8")).toBe(
        "COLLIDING-WRITER-CONTENT",
      );
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("does not attempt to unlink tmp when the exclusive open itself fails for a non-EEXIST reason", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-open-enospc-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realUnlinkSync = actualFs.unlinkSync;
    const realFs = { ...actualFs };

    // A non-EEXIST failure from the exclusive open (ENOSPC, EDQUOT, EACCES,
    // EROFS, ...) can occur before ANY directory entry for `tmp` exists —
    // ownership was never established, so cleanup must not even attempt an
    // unlink. An earlier fix inferred ownership from writeFileSync's error code
    // and got exactly this case wrong.
    let unlinkCalled = false;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "wx") {
          const err = new Error(
            "simulated ENOSPC on open",
          ) as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          throw err;
        }
        return realOpenSync(path, flags);
      },
      unlinkSync: (path: string) => {
        unlinkCalled = true;
        return realUnlinkSync(path);
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow(
        "simulated ENOSPC on open",
      );
      expect(unlinkCalled).toBe(false);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("writes the whole buffer even when writeSync returns a short byte count", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-shortwrite-"));
    const target = join(dir, "file.json");
    const content = "hello world\n";

    const actualFs = await import("node:fs");
    const realWriteSync = actualFs.writeSync;
    const realFs = { ...actualFs };

    // `writeSync` can legitimately return fewer bytes than requested
    // without throwing — the underlying `write(2)` makes no promise to
    // write everything in one call. Simulated here by forcing the FIRST
    // call to write only 1 byte, then letting subsequent calls proceed
    // normally, so a caller that ignores the return value would silently
    // truncate to 1 byte.
    let callCount = 0;
    mock.module("node:fs", () => ({
      ...realFs,
      writeSync: (
        fd: number,
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number | null,
      ) => {
        callCount += 1;
        if (callCount === 1 && (length ?? 0) > 1) {
          return realWriteSync(fd, buffer, offset, 1, position);
        }
        return realWriteSync(fd, buffer, offset, length, position);
      },
    }));

    try {
      atomicWrite(target, content);
      expect(readFileSync(target, "utf8")).toBe(content);
      expect(callCount).toBeGreaterThan(1); // proves the loop actually ran
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("refuses rather than spinning forever when writeSync makes no progress (returns 0)", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-zerowrite-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };

    // A ZERO-byte result is distinct from a short-but-positive one: the
    // short-write loop above trusted every result was positive, so
    // `offset += 0` never advances — an unbounded synchronous spin, not a
    // corruption.
    let calls = 0;
    mock.module("node:fs", () => ({
      ...realFs,
      writeSync: () => {
        calls += 1;
        if (calls > 20) {
          // Circuit breaker: a genuine infinite loop here would hang the
          // test runner rather than fail it — this converts that into an
          // explicit, immediate, distinctly-worded failure instead, so a
          // regression is caught as a clean red rather than a stall.
          throw new Error(
            "writeSync called >20 times — this looks like the infinite loop",
          );
        }
        return 0;
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow(/no progress/);
      // Refused on the FIRST zero-byte result — no retry loop at all.
      expect(calls).toBe(1);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("skips the directory fsync entirely on Windows, where opening a directory fails before it can even try", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-win32-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFs = { ...actualFs };

    // On Windows, `openSync(directory, 'r')` itself fails — there is no
    // error code to allowlist, because the open never succeeds far
    // enough to reach one. Tracked here via a call counter: if the
    // directory-fsync step were attempted at all on win32, this mock
    // would throw and atomicWrite would incorrectly report failure on a
    // write that already landed.
    let dirOpenAttempted = false;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "r" && path === dir) {
          dirOpenAttempted = true;
          throw new Error("directories cannot be opened this way on win32");
        }
        return realOpenSync(path, flags);
      },
    }));

    const savedPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      expect(() => atomicWrite(target, "content\n")).not.toThrow();
      expect(readFileSync(target, "utf8")).toBe("content\n");
      expect(dirOpenAttempted).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", {
        value: savedPlatform,
        configurable: true,
      });
      mock.module("node:fs", () => realFs);
    }
  });

  it("cleans up the temp file when renameSync fails, rather than leaking it", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-atomic-write-renamefail-"));
    const target = join(dir, "file.json");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };

    mock.module("node:fs", () => ({
      ...realFs,
      renameSync: () => {
        throw new Error("simulated rename failure");
      },
    }));

    try {
      expect(() => atomicWrite(target, "content\n")).toThrow(
        "simulated rename failure",
      );
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });
});

describe("fsyncFileSync", () => {
  it("does not throw on an existing, already-flushed file", () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-fsync-file-"));
    const target = join(dir, "file.txt");
    writeFileSyncReal(target, "content\n");
    expect(() => fsyncFileSync(target)).not.toThrow();
  });

  it("propagates a genuine fsync failure — unlike fsyncDirectoryBestEffort, there is no ENOTSUP/EINVAL carve-out for a plain file", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-fsync-file-fail-"));
    const target = join(dir, "file.txt");
    writeFileSyncReal(target, "content\n");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      fsyncSync: () => {
        const err = new Error(
          "simulated file fsync failure",
        ) as NodeJS.ErrnoException;
        err.code = "ENOTSUP";
        throw err;
      },
    }));

    try {
      expect(() => fsyncFileSync(target)).toThrow(
        "simulated file fsync failure",
      );
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("preserves the primary fsync error over a close failure, rather than letting the close error replace it", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-fsync-file-closefail-"));
    const target = join(dir, "file.txt");
    writeFileSyncReal(target, "content\n");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      fsyncSync: () => {
        throw new Error("primary fsync failure");
      },
      closeSync: () => {
        throw new Error("secondary close failure");
      },
    }));

    try {
      expect(() => fsyncFileSync(target)).toThrow("primary fsync failure");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });
});

describe("createExclusiveDurable", () => {
  it("writes content that is readable at the target path afterward", () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-exclusive-create-"));
    const target = join(dir, "id-file");
    createExclusiveDurable(target, "minted-value\n");
    expect(readFileSync(target, "utf8")).toBe("minted-value\n");
  });

  it("refuses to overwrite an existing target — the exclusivity a racing minter depends on", () => {
    // This is the property `clone-key.ts`'s `persistedCloneId` race-safety
    // argument rests on entirely: the loser of a concurrent mint must fail,
    // not silently clobber whichever id actually landed first.
    dir = mkdtempSync(join(tmpdir(), "fsutil-exclusive-create-eexist-"));
    const target = join(dir, "id-file");
    createExclusiveDurable(target, "winner\n");
    expect(() => createExclusiveDurable(target, "loser\n")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("winner\n");
    // The loser's own temp file must not survive either — nothing but the
    // target itself should be left in the directory.
    expect(readdirSync(dir)).toEqual(["id-file"]);
  });

  it("throws the LOSER's EEXIST unwrapped — the one outcome where this call never touched the target", () => {
    // `clone-key.ts`'s `persistedCloneId` tells "I own this failure" apart
    // from "I lost a genuine race" by whether the thrown error is an
    // `ExclusiveWriteOwnFailure` — see that class's own doc. The publishing
    // `linkSync`'s EEXIST is the one failure that must NOT be wrapped: it
    // means another process's link already landed, so this call created
    // nothing.
    dir = mkdtempSync(join(tmpdir(), "fsutil-exclusive-create-eexist-type-"));
    const target = join(dir, "id-file");
    createExclusiveDurable(target, "winner\n");
    try {
      createExclusiveDurable(target, "loser\n");
      throw new Error("expected createExclusiveDurable to throw");
    } catch (e) {
      expect(e).not.toBeInstanceOf(ExclusiveWriteOwnFailure);
      expect((e as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
  });

  it("fsyncs both the temp file and its containing directory on success, and publishes the target via link", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-exclusive-create-fsync-"));
    const target = join(dir, "id-file");

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFsyncSync = actualFs.fsyncSync;
    const realFs = { ...actualFs };

    // Tracked by PATH, not by the fd number `openSync` returns: the temp file's
    // fd is closed before `fsyncDirectoryBestEffort` ever opens the directory,
    // so the OS is free to hand back the SAME fd number for both — a Set of raw
    // fd numbers would then let one directory fsync satisfy both assertions
    // below even if the temp-file fsync were removed entirely, leaving that
    // regression undetected.
    const fdPaths = new Map<number, string>();
    const fsyncedPaths: string[] = [];
    // The content is written to a UNIQUE TEMP path beside the target, never
    // to the target itself — see `createExclusiveDurable`'s own doc for why:
    // a
    // direct `wx` open of the target would create its directory entry
    // before any content lands, exposing an empty-or-partial read to a
    // concurrent loser.
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        const fd = realOpenSync(path, flags);
        fdPaths.set(fd, path);
        return fd;
      },
      fsyncSync: (fd: number) => {
        fsyncedPaths.push(fdPaths.get(fd) ?? `<unknown fd ${fd}>`);
        return realFsyncSync(fd);
      },
    }));

    try {
      createExclusiveDurable(target, "content\n");
      expect(fsyncedPaths.some((p) => p.startsWith(`${target}.`))).toBe(true);
      expect(fsyncedPaths).toContain(dir);
      expect(readFileSync(target, "utf8")).toBe("content\n");
      // The temp file is disposable once linked — nothing but the target
      // itself should remain in the directory afterward.
      expect(readdirSync(dir)).toEqual(["id-file"]);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("propagates a write/fsync failure as ExclusiveWriteOwnFailure rather than reporting a partial write as success", async () => {
    dir = mkdtempSync(join(tmpdir(), "fsutil-exclusive-create-writefail-"));
    const target = join(dir, "id-file");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      fsyncSync: () => {
        throw new Error("simulated fsync failure");
      },
    }));

    try {
      expect(() => createExclusiveDurable(target, "content\n")).toThrow(
        "simulated fsync failure",
      );
      try {
        createExclusiveDurable(target, "content\n");
        throw new Error("expected createExclusiveDurable to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ExclusiveWriteOwnFailure);
      }
      // Own failure this early means the target was never touched at all —
      // and its temp file must not survive the failure either.
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("reports a post-link directory-fsync failure as ExclusiveDurabilityUnconfirmed, distinct from ExclusiveWriteOwnFailure, and leaves the already-published target in place", async () => {
    // The gap this closes: the publishing
    // `link` can succeed and THEN the trailing `fsyncDirectoryBestEffort`
    // call can fail (EIO/ENOSPC on the directory fd) — a failure shape that
    // is neither "this call's own write never landed" (ExclusiveWriteOwnFailure)
    // nor a racing EEXIST. `persistedCloneId` must be able to tell this case
    // apart from both so it doesn't adopt an unconfirmed publish as though a
    // racing winner had vouched for it.
    dir = mkdtempSync(join(tmpdir(), "fsutil-exclusive-create-dirfsync-"));
    const target = join(dir, "id-file");

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
      try {
        createExclusiveDurable(target, "content\n");
        throw new Error("expected createExclusiveDurable to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ExclusiveDurabilityUnconfirmed);
        expect(e).not.toBeInstanceOf(ExclusiveWriteOwnFailure);
      }
      // The link already published the target with this call's own
      // content — unlike the own-failure-before-publish case above, there
      // is nothing to roll back, and nothing safe to delete either.
      expect(readFileSync(target, "utf8")).toBe("content\n");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });
});
