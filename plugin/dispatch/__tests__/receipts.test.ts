/** dispatch receipts: validation, retention per repository, the tick lock. */
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId,
  previousFollowupSince,
  pruneReceipts,
  readReceipt,
  receiptPaths,
  takeTickLock,
  type TickReceipt,
  writeReceipt,
} from "../receipts.ts";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-receipts-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function receipt(day: string, repoPath: string, since: string): TickReceipt {
  const at = new Date(`${day}T10:00:00Z`);
  return {
    version: 1,
    runId: newRunId(at),
    startedAt: at.toISOString(),
    finishedAt: at.toISOString(),
    completed: true,
    apply: false,
    exitStatus: 0,
    repos: [
      {
        path: repoPath,
        slug: null,
        refused: null,
        section: null,
        followupSince: since,
        records: [],
        actions: [],
        running: [],
        unplaced: [],
        quiet: [],
      },
    ],
  };
}

describe("readReceipt", () => {
  it("skips a receipt whose repository entry is not one", () => {
    const dir = root();
    const bad = {
      ...receipt("2026-01-01", "/a", "2026-01-01T00:00:00Z"),
      repos: [null],
    };
    const path = writeReceipt(bad as unknown as TickReceipt, dir);
    expect(readReceipt(path)).toBeNull();
  });
});

describe("pruneReceipts", () => {
  it("keeps the latest receipt of every repository", () => {
    const dir = root();
    const a = writeReceipt(
      receipt("2026-01-01", "/a", "2026-01-01T00:00:00Z"),
      dir,
    );
    writeReceipt(receipt("2026-03-01", "/b", "2026-03-01T00:00:00Z"), dir);
    const removed = pruneReceipts(Date.parse("2026-06-01T00:00:00Z"), dir);
    expect(removed).not.toContain(a);
    expect(previousFollowupSince("/a", dir)).toBe("2026-01-01T00:00:00Z");
    expect(receiptPaths(dir)).toHaveLength(2);
  });
});

describe("takeTickLock", () => {
  it("lets one tick hold the lock and only its owner release it", () => {
    const dir = root();
    const first = takeTickLock(dir);
    expect("release" in first).toBe(true);
    expect("heldBy" in takeTickLock(dir)).toBe(true);
    if ("release" in first) first.release();
    expect("release" in takeTickLock(dir)).toBe(true);
  });

  it("treats a fresh empty lock as being written, an old one as abandoned", () => {
    const dir = root();
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, "tick.lock");
    writeFileSync(lock, "");
    expect("heldBy" in takeTickLock(dir)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect("release" in takeTickLock(dir)).toBe(true);
  });

  it("replaces a lock whose holder is gone", () => {
    const dir = root();
    writeFileSync(join(dir, "tick.lock"), "2147483646");
    expect("release" in takeTickLock(dir)).toBe(true);
  });
});
