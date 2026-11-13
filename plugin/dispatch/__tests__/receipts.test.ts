/** dispatch receipts: validation, retention per repository, the tick lock. */
import { closeStateDb } from "../lib/state.ts";
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootId,
  decodeIdentity,
  encodeIdentity,
  lockIdentity,
} from "../../shared/liveness.ts";
import {
  lastTick,
  newRunId,
  nextTickIndex,
  previousFollowupSince,
  pruneReceipts,
  readReceipt,
  receiptPaths,
  takeTickLock,
  type TickReceipt,
  writeReceipt,
} from "../receipts.ts";
import { isoFromMs, isoOf } from "../../shared/time.ts";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-receipts-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function receipt(day: string, repoPath: string, since: string): TickReceipt {
  const at = Temporal.Instant.from(`${day}T10:00:00Z`);
  return {
    version: 1,
    runId: newRunId(at),
    startedAt: isoOf(at),
    finishedAt: isoOf(at),
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
        launches: [],
        notifications: [],
        quiet: [],
      },
    ],
  };
}

/** A tick's receipt at `iso` with the exit it ended with, and the defect that stopped it when one did. */
function tickAt(iso: string, exitStatus: number, defect?: string): TickReceipt {
  const at = Temporal.Instant.from(iso);
  return {
    version: 1,
    runId: newRunId(at),
    startedAt: isoOf(at),
    finishedAt: isoOf(at),
    completed: defect === undefined,
    apply: true,
    exitStatus,
    ...(defect === undefined
      ? {}
      : {
          defect: { code: "defect" as const, phase: "start", reason: defect },
        }),
    repos: [],
  };
}

describe("lastTick", () => {
  it("names the failed ticks in a row the latest one ends, since the first of them, and the latest reason", () => {
    const dir = root();
    writeReceipt(tickAt("2026-01-01T09:00:00Z", 1), dir);
    writeReceipt(tickAt("2026-01-01T10:00:00Z", 0), dir);
    writeReceipt(tickAt("2026-01-01T11:00:00Z", 1, "first"), dir);
    writeReceipt(tickAt("2026-01-01T12:00:00Z", 1), dir);
    const latest = tickAt(
      "2026-01-02T08:00:00Z",
      2,
      "the state database is refused",
    );
    writeReceipt(latest, dir);
    // A held tick ran nothing: it neither ends the run nor is the last run.
    writeReceipt(
      { ...tickAt("2026-01-02T09:00:00Z", 3), lockHeldBy: "pid 1" },
      dir,
    );
    expect(lastTick(dir)).toMatchObject({
      runId: latest.runId,
      completed: false,
      exitStatus: 2,
      reason: "the state database is refused",
      failing: { runs: 3, since: "2026-01-01T11:00:00.000Z", capped: false },
    });
  });

  it("carries no failed run when the latest tick passed", () => {
    const dir = root();
    writeReceipt(tickAt("2026-01-01T09:00:00Z", 1, "earlier"), dir);
    writeReceipt(tickAt("2026-01-01T10:00:00Z", 0), dir);
    const last = lastTick(dir);
    expect(last?.exitStatus).toBe(0);
    expect(last?.failing).toBeUndefined();
    expect(last?.reason).toBeUndefined();
  });

  it("stops reading back at its limit and says there were at least that many", () => {
    const dir = root();
    for (let i = 0; i < 101; i++)
      writeReceipt(tickAt(isoFromMs(Date.UTC(2026, 0, 1, 0, i)), 1), dir);
    expect(lastTick(dir)?.failing).toEqual({
      runs: 100,
      since: "2026-01-01T00:01:00.000Z",
      capped: true,
    });
  });
});

describe("lastTick's receipts that do not read", () => {
  const badRows = [
    ["unplaced", { unplaced: [null] }],
    ["records", { records: [null] }],
  ] as const;

  for (const [name, patch] of badRows) {
    it(`is unknown, not an older success, when the newest receipt's ${name} rows are not objects`, () => {
      const dir = root();
      writeReceipt(tickAt("2026-01-01T09:00:00Z", 0), dir);
      const failed = tickAt("2026-01-01T10:00:00Z", 1, "failed");
      const entry = {
        ...receipt("2026-01-01", "/a", "2026-01-01T10:00:00Z").repos[0],
        ...patch,
      };
      writeReceipt(
        { ...failed, repos: [entry] } as unknown as TickReceipt,
        dir,
      );
      expect(lastTick(dir)).toMatchObject({ exitStatus: 1, unread: 1 });
    });
  }

  it("caps the failed run at a receipt that does not read", () => {
    const dir = root();
    writeReceipt(tickAt("2026-01-01T08:00:00Z", 0), dir);
    const bad = { ...tickAt("2026-01-01T09:00:00Z", 1), repos: [null] };
    writeReceipt(bad as unknown as TickReceipt, dir);
    writeReceipt(tickAt("2026-01-01T10:00:00Z", 1, "failed"), dir);
    expect(lastTick(dir)?.failing).toMatchObject({ runs: 1, capped: true });
  });

  it("is not capped when the budget ends exactly at the oldest receipt", () => {
    const dir = root();
    for (let i = 0; i < 98; i++)
      writeReceipt(
        {
          ...tickAt(isoFromMs(Date.UTC(2026, 0, 1, 0, i)), 0),
          lockHeldBy: "other-tick",
        },
        dir,
      );
    writeReceipt(tickAt("2026-01-01T02:00:00Z", 1), dir);
    writeReceipt(tickAt("2026-01-01T02:01:00Z", 1), dir);
    expect(lastTick(dir)?.failing).toMatchObject({ runs: 2, capped: false });
  });
});

describe("lastTick's read budget", () => {
  it("spends a read on every held receipt, so a backlog of them is no unbounded scan", () => {
    const dir = root();
    writeReceipt(tickAt("2026-01-01T00:00:00Z", 1), dir);
    for (let i = 1; i <= 150; i++)
      writeReceipt(
        {
          ...tickAt(isoFromMs(Date.UTC(2026, 0, 1, 0, i)), 0),
          lockHeldBy: "other-tick",
        },
        dir,
      );
    expect(lastTick(dir)?.unread).toBe(100);
  });

  it("is null, not unread, when every receipt was read and none ran", () => {
    const dir = root();
    writeReceipt(
      { ...tickAt("2026-01-01T00:00:00Z", 0), lockHeldBy: "x" },
      dir,
    );
    expect(lastTick(dir)).toBeNull();
  });
});

describe("readReceipt", () => {
  it("skips a receipt whose unplaced or record rows are not objects", () => {
    const dir = root();
    const base = receipt("2026-01-01", "/a", "2026-01-01T00:00:00Z");
    const entry = { ...(base.repos[0] as object), unplaced: [null] };
    const path = writeReceipt(
      { ...base, repos: [entry] } as unknown as TickReceipt,
      dir,
    );
    expect(readReceipt(path)).toBeNull();
  });

  it("skips a receipt whose repository entry lacks the unplaced rows failure rendering reads", () => {
    const dir = root();
    const base = receipt("2026-01-01", "/a", "2026-01-01T00:00:00Z");
    const { unplaced: _unplaced, ...entry } = base.repos[0] as never as Record<
      string,
      unknown
    >;
    const path = writeReceipt(
      { ...base, repos: [entry] } as unknown as TickReceipt,
      dir,
    );
    expect(readReceipt(path)).toBeNull();
  });

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

  it("keeps the newest window of a repository whose latest receipt has none", () => {
    const dir = root();
    const windowed = writeReceipt(
      receipt("2026-01-01", "/a", "2026-01-01T00:00:00Z"),
      dir,
    );
    const refused = receipt("2026-03-01", "/a", "");
    refused.repos = refused.repos.map((r) => ({ ...r, followupSince: null }));
    writeReceipt(refused, dir);
    const removed = pruneReceipts(Date.parse("2026-06-01T00:00:00Z"), dir);
    expect(removed).not.toContain(windowed);
    expect(previousFollowupSince("/a", dir)).toBe("2026-01-01T00:00:00Z");
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

  it("names the live holder of a held lock by its identity", () => {
    const dir = root();
    const first = takeTickLock(dir);
    const second = takeTickLock(dir);
    expect("heldBy" in second && second.heldBy).toContain(
      `pid ${process.pid} on `,
    );
    if ("release" in first) first.release();
  });

  it("records the holder's identity beside the lock and removes it on release", () => {
    const dir = root();
    const lock = takeTickLock(dir);
    expect(readFileSync(join(dir, "tick.lock"), "utf8")).toBe(
      String(process.pid),
    );
    const holder = decodeIdentity(
      readFileSync(join(dir, "tick.lock.holder"), "utf8"),
    );
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.start).toBe(lockIdentity().start);
    if ("release" in lock) lock.release();
    expect(readdirSync(dir).filter((n) => n.startsWith("tick.lock"))).toEqual(
      [],
    );
  });

  it("reclaims a lock whose pid now belongs to a process that started at another time", () => {
    const dir = root();
    const reused = { ...lockIdentity(), start: "Mon Jan  1 00:00:00 2001" };
    writeFileSync(join(dir, "tick.lock"), String(process.pid));
    writeFileSync(join(dir, "tick.lock.holder"), encodeIdentity(reused));
    expect("release" in takeTickLock(dir)).toBe(true);
    expect(
      decodeIdentity(readFileSync(join(dir, "tick.lock.holder"), "utf8"))
        ?.start,
    ).toBe(lockIdentity().start);
  });

  it.skipIf(bootId() === "")(
    "reclaims a lock its holder took before this host last restarted",
    () => {
      const dir = root();
      const before = { ...lockIdentity(), bootId: "an-earlier-boot" };
      writeFileSync(join(dir, "tick.lock"), String(process.pid));
      writeFileSync(join(dir, "tick.lock.holder"), encodeIdentity(before));
      expect("release" in takeTickLock(dir)).toBe(true);
    },
  );

  it("judges a lock by its pid alone when the identity beside it is older than the lock", () => {
    const dir = root();
    const reused = { ...lockIdentity(), start: "Mon Jan  1 00:00:00 2001" };
    writeFileSync(join(dir, "tick.lock.holder"), encodeIdentity(reused));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "tick.lock.holder"), old, old);
    writeFileSync(join(dir, "tick.lock"), String(process.pid));
    expect("heldBy" in takeTickLock(dir)).toBe(true);
  });

  it("keeps a lock in the earlier form whose pid still answers", () => {
    const dir = root();
    writeFileSync(join(dir, "tick.lock"), String(process.pid));
    expect("heldBy" in takeTickLock(dir)).toBe(true);
  });

  it("replaces a lock whose holder is gone", () => {
    const dir = root();
    writeFileSync(join(dir, "tick.lock"), "2147483646");
    expect("release" in takeTickLock(dir)).toBe(true);
  });

  it("leaves a guard a successor holds alone and yields to it", () => {
    const dir = root();
    writeFileSync(join(dir, "tick.lock"), "2147483646");
    writeFileSync(join(dir, "tick.lock.reclaim.1"), String(process.pid));
    expect("heldBy" in takeTickLock(dir)).toBe(true);
    expect(readFileSync(join(dir, "tick.lock.reclaim.1"), "utf8")).toBe(
      String(process.pid),
    );
  });

  it("recovers past a guard whose owner is gone", () => {
    const dir = root();
    writeFileSync(join(dir, "tick.lock"), "2147483646");
    writeFileSync(join(dir, "tick.lock.reclaim.1"), "2147483645");
    expect("release" in takeTickLock(dir)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes(".reclaim."))).toEqual([
      "tick.lock.reclaim.2",
    ]);
  });

  it("never reuses a guard generation after a reclaim", () => {
    const dir = root();
    for (let round = 1; round <= 3; round++) {
      writeFileSync(join(dir, "tick.lock"), "2147483646");
      expect("release" in takeTickLock(dir)).toBe(true);
      expect(readdirSync(dir).filter((n) => n.includes(".reclaim."))).toEqual([
        `tick.lock.reclaim.${round}`,
      ]);
    }
  });
});

describe("the tick index", () => {
  it("advances by one a call and starts over when unreadable", () => {
    const dir = root();
    expect([
      nextTickIndex(dir),
      nextTickIndex(dir),
      nextTickIndex(dir),
    ]).toEqual([0, 1, 2]);
    writeFileSync(join(dir, "tick-index"), "not a number\n");
    expect(nextTickIndex(dir)).toBe(0);
  });

  it("names why the index cannot be read or recorded", () => {
    const dir = root();
    mkdirSync(join(dir, "tick-index"));
    const result = nextTickIndex(dir);
    expect(result).toEqual({
      failed: expect.stringContaining(
        `${join(dir, "tick-index")} cannot be read`,
      ),
    });
  });
});
