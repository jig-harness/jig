/**
 * mailbox-append.test.ts — how `lib/state/mailbox.ts` appends: the
 * disposable tag on the mailbox directory, and the fsyncs that make a first
 * append durable. The rest of the mailbox is in `mailbox.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNote,
  appendOutboxRecord,
  inboxPath,
  isPushHeld,
  readPushHoldUnderLock,
  unseenMessages,
} from "../scripts/lib/state/mailbox.ts";
import {
  CACHEDIR_TAG,
  CACHEDIR_TAG_SIGNATURE,
  markDisposable,
} from "../../../shared/disposable-mark.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drive-pr-mailbox-append-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the disposable tag", () => {
  const tagged = (mailbox: string) =>
    readFileSync(join(mailbox, CACHEDIR_TAG), "utf8").startsWith(
      CACHEDIR_TAG_SIGNATURE,
    );

  it("tags a mailbox the first append creates, and the tag is not a message", async () => {
    const mailbox = join(dir, ".context", "drive-mailbox");
    await appendNote(mailbox, "999", "orchestrator", "hello");
    expect(tagged(mailbox)).toBe(true);
    const unseen = unseenMessages(mailbox, "999");
    expect(unseen.ok && unseen.messages.length).toBe(1);
    expect(isPushHeld(mailbox, "999")).toEqual({ blocked: false, reason: "" });
  });

  it("tags the mailbox on the drive's side and at the pre-push read", async () => {
    const outboxSide = join(dir, "outbox-side");
    await appendOutboxRecord(outboxSide, {
      id: "m-1",
      ts: new Date().toISOString(),
      pr: "999",
      status: "received",
    });
    expect(tagged(outboxSide)).toBe(true);
    const pushSide = join(dir, "push-side");
    expect(await readPushHoldUnderLock(pushSide, "999", "test")).toEqual({
      blocked: false,
      reason: "",
    });
    expect(tagged(pushSide)).toBe(true);
  });
});

describe("appendLine durability (fsync after append)", () => {
  it("fsyncs the file after every append, not just a plain buffered write", async () => {
    // A plain `writeFileSync(path, content, {flag:'a'})` reports success once
    // the bytes reach the page cache, not stable storage -- on a crash
    // immediately after, a hold-push directive could be lost while
    // foldGateState reads the resulting file as CLEAR.
    const actualFs = await import("node:fs");
    const realFsyncSync = actualFs.fsyncSync;
    const realFs = { ...actualFs };
    let fsyncCalls = 0;
    mock.module("node:fs", () => ({
      ...realFs,
      fsyncSync: (fd: number) => {
        fsyncCalls += 1;
        return realFsyncSync(fd);
      },
    }));
    try {
      await appendNote(dir, "999", "orchestrator", "hello");
      expect(fsyncCalls).toBeGreaterThan(0);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the directory fsync is skipped on Windows (opening a directory fails with EPERM), so the directory open this test observes never happens",
    ),
  )(
    "fsyncs the containing directory only when creating the mailbox file for the first time, not on every append",
    async () => {
      // The FILE's own fsync does not make the DIRECTORY ENTRY pointing at
      // it durable -- that only matters the first time inbox.jsonl is
      // created, not on a later append to an already-durable file.
      const actualFs = await import("node:fs");
      const realOpenSync = actualFs.openSync;
      const realFs = { ...actualFs };
      let dirOpenCount = 0;
      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (path: string, flags: string) => {
          if (flags === "r" && path === dir) dirOpenCount += 1;
          return realOpenSync(path, flags);
        },
      }));
      try {
        await appendNote(dir, "999", "orchestrator", "first"); // creates inbox.jsonl
        expect(dirOpenCount).toBe(1);
        await appendNote(dir, "999", "orchestrator", "second"); // appends to an existing file
        expect(dirOpenCount).toBe(1); // unchanged — no repeated directory fsync
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the directory fsync is skipped on Windows (opening a directory fails with EPERM), so the directory open this test observes never happens",
    ),
  )(
    "fsyncs every newly created ancestor directory, not just the immediate parent, when multiple levels are missing",
    async () => {
      // Fresh evidence beyond the single-level fix above: `mkdirSync`'s own
      // `recursive: true` can create MULTIPLE missing levels in one call
      // (mirroring `.context/drive-mailbox` both being absent on a fresh
      // worktree). Fsyncing only `dirname(path)` (the mailbox directory
      // itself) would leave its OWN entry — in ITS now-also-new parent —
      // undurable, so a power loss could discard the whole newly created
      // mailbox directory tree even though the file inside it was fsynced.
      const nestedContext = join(dir, "nested-context");
      const nestedMailbox = join(nestedContext, "drive-mailbox");
      expect(existsSync(nestedContext)).toBe(false);

      const actualFs = await import("node:fs");
      const realOpenSync = actualFs.openSync;
      const realFs = { ...actualFs };
      const fsyncedDirs = new Set<string>();
      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (path: string, flags: string) => {
          if (flags === "r") fsyncedDirs.add(path);
          return realOpenSync(path, flags);
        },
      }));

      try {
        await appendNote(nestedMailbox, "999", "orchestrator", "hello");
        // All three levels fsynced: the mailbox dir itself (the file's own
        // entry), its newly created parent (the mailbox dir's own entry),
        // and the PRE-EXISTING grandparent (the new parent's own entry).
        expect(fsyncedDirs.has(nestedMailbox)).toBe(true);
        expect(fsyncedDirs.has(nestedContext)).toBe(true);
        expect(fsyncedDirs.has(dir)).toBe(true);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the directory fsync is skipped on Windows (opening a directory fails with EPERM), so the directory open this test observes never happens",
    ),
  )(
    "fsyncs the parent and grandparent unconditionally, even when THIS call's own mkdirSync reports nothing was created — closes the concurrent-first-sender race",
    async () => {
      // Simulates the concurrent-first-sender race: a CONCURRENT sender creates
      // the whole directory chain moments before this call's own mkdirSync runs
      // (so mkdirSync here legitimately returns `undefined` — the whole chain
      // already exists by the time THIS process calls it) — yet the
      // parent/grandparent directory entries are STILL newly created (by the
      // other sender) and still need fsyncing, which this process has no way to
      // know from its own mkdirSync return value alone. An earlier fix relied on
      // exactly that return value and would have fsynced only `nestedMailbox`
      // here, missing both ancestors.
      const nestedContext = join(dir, "raced-context");
      const nestedMailbox = join(nestedContext, "drive-mailbox");
      mkdirSync(nestedMailbox, { recursive: true }); // the "concurrent sender" already created it

      const actualFs = await import("node:fs");
      const realOpenSync = actualFs.openSync;
      const realFs = { ...actualFs };
      const fsyncedDirs = new Set<string>();
      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (path: string, flags: string) => {
          if (flags === "r") fsyncedDirs.add(path);
          return realOpenSync(path, flags);
        },
      }));

      try {
        await appendNote(nestedMailbox, "999", "orchestrator", "hello");
        expect(fsyncedDirs.has(nestedMailbox)).toBe(true);
        expect(fsyncedDirs.has(nestedContext)).toBe(true);
        expect(fsyncedDirs.has(dir)).toBe(true);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the directory fsync is skipped on Windows (opening a directory fails with EPERM), so the directory open this test observes never happens",
    ),
  )(
    "flushes every ancestor created by a $DRIVE_PR_MAILBOX_DIR override deeper than the default two-level layout",
    async () => {
      // The fixed two-level floor (mailboxDir() === worktreeRoot/.context/
      // drive-mailbox) only bounds the DEFAULT production layout. Under the
      // test/operator override, `resolveMailboxDir()` permits an arbitrarily deep
      // path, and mkdirSync's own recursive create walks as far up as it needs to
      // — a chain missing MORE than two levels would leave the higher, still-new
      // ancestors unfsynced if the walk stopped at the fixed floor alone.
      const level1 = join(dir, "override-l1");
      const level2 = join(level1, "override-l2");
      const level3 = join(level2, "override-l3");
      const nestedMailbox = join(level3, "drive-mailbox");
      expect(existsSync(level1)).toBe(false);

      const actualFs = await import("node:fs");
      const realOpenSync = actualFs.openSync;
      const realFs = { ...actualFs };
      const fsyncedDirs = new Set<string>();
      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (path: string, flags: string) => {
          if (flags === "r") fsyncedDirs.add(path);
          return realOpenSync(path, flags);
        },
      }));

      try {
        await appendNote(nestedMailbox, "999", "orchestrator", "hello");
        // Every level from the mailbox dir up through the pre-existing
        // `dir` is fsynced — four levels, past the fixed three-level floor.
        expect(fsyncedDirs.has(nestedMailbox)).toBe(true);
        expect(fsyncedDirs.has(level3)).toBe(true);
        expect(fsyncedDirs.has(level2)).toBe(true);
        expect(fsyncedDirs.has(level1)).toBe(true);
        expect(fsyncedDirs.has(dir)).toBe(true);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the directory fsync is skipped on Windows (opening a directory fails with EPERM), so the directory open this test observes never happens",
    ),
  )(
    "cleans up a file it created when write/fsync/close then fails, so a retry correctly re-observes absent and re-runs the ancestor fsyncs",
    async () => {
      // Without cleanup, a failed FIRST append that already created the
      // file (openSync('a') creates transparently, whether or not the file
      // existed) leaves an empty/partial file behind. A later, otherwise-
      // successful retry would then observe existing.kind === 'ok' — not
      // 'absent' — setting fileIsNew false and skipping the ancestor-
      // directory fsyncs entirely, even though nobody has ever run them.
      const path = inboxPath(dir);
      // Tag the mailbox first, so the write that fails below is the append's
      // own and not the tag's.
      expect(markDisposable(dir).ok).toBe(true);

      const actualFs = await import("node:fs");
      const realWriteSync = actualFs.writeSync;
      const realFs = { ...actualFs };
      let failNextWrite = true;
      mock.module("node:fs", () => ({
        ...realFs,
        writeSync: (
          fd: number,
          buffer: Uint8Array,
          offset?: number,
          length?: number,
          position?: number | null,
        ) => {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error("simulated ENOSPC mid-write");
          }
          return realWriteSync(fd, buffer, offset, length, position);
        },
      }));
      try {
        await expect(
          appendNote(dir, "999", "orchestrator", "first attempt"),
        ).rejects.toThrow("simulated ENOSPC mid-write");
        // The failed attempt's file must be cleaned up, restoring `absent`
        // for the next attempt to correctly re-observe.
        expect(existsSync(path)).toBe(false);
      } finally {
        mock.module("node:fs", () => realFs);
      }

      const realOpenSync = actualFs.openSync;
      const fsyncedDirs = new Set<string>();
      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (p: string, flags: string) => {
          if (flags === "r") fsyncedDirs.add(p);
          return realOpenSync(p, flags);
        },
      }));
      try {
        await appendNote(dir, "999", "orchestrator", "retry");
        // The retry correctly re-observed `absent` (thanks to the cleanup
        // above) and ran the ancestor-directory fsync this time.
        expect(fsyncedDirs.has(dir)).toBe(true);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );
});
