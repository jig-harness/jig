import { expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../scripts/lib/state/fsutil.ts";
import { inboxPath, repairInbox } from "../scripts/lib/state/mailbox.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

it.skipIf(
  skipsOnWindows("file-system", "Directory fsync is skipped on Windows"),
)(
  "distinguishes published content and flushes a repaired inbox on retry",
  async () => {
    const realFs = { ...fs };
    const dir = fs.mkdtempSync(join(tmpdir(), "atomic-durability-"));
    const target = join(dir, "target");
    const inbox = inboxPath(dir);
    fs.writeFileSync(inbox, '{}\n{"truncated');
    let directoryFd = -1;
    let failFlush = true;
    let flushes = 0;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        const fd = realFs.openSync(path, flags);
        if (path === dir && flags === "r") directoryFd = fd;
        return fd;
      },
      closeSync: (fd: number) => {
        if (fd === directoryFd) directoryFd = -1;
        return realFs.closeSync(fd);
      },
      fsyncSync: (fd: number) => {
        if (fd === directoryFd) {
          flushes++;
          if (failFlush)
            throw Object.assign(new Error("directory EIO"), { code: "EIO" });
        }
        return realFs.fsyncSync(fd);
      },
    }));
    try {
      let failure: unknown;
      try {
        atomicWrite(target, "published");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("AtomicDurabilityUnconfirmed");
      expect(realFs.readFileSync(target, "utf8")).toBe("published");
      await expect(repairInbox(dir, false)).rejects.toThrow("directory EIO");
      expect(realFs.readFileSync(inbox, "utf8")).toBe("{}\n");
      const failedFlushes = flushes;
      failFlush = false;
      const repaired = await repairInbox(dir, false);
      expect(repaired.ok).toBe(true);
      expect(flushes).toBeGreaterThan(failedFlushes);
      if (repaired.ok) expect(repaired.droppedLines).toBe(0);
      const beforeDryRun = flushes;
      await repairInbox(dir, true);
      expect(flushes).toBe(beforeDryRun);
    } finally {
      mock.module("node:fs", () => realFs);
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
