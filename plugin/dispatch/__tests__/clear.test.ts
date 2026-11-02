import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMain } from "../clear.ts";
import { type LaunchRecord, recordExit, writeRecord } from "../lib/launches.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true });
  }
});

const ID = "20260101T000000Z-aaaaaaaa";

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-clear-"));
  dirs.push(dir);
  return dir;
}

function record(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 1,
    id: ID,
    token: "t",
    action: "rearm",
    repo: "o/a",
    repoPath: "/r",
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "f",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspace: null,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    ...over,
  };
}

async function clear(dir: string): Promise<number> {
  const err = spyOn(console, "error").mockImplementation(() => undefined);
  const out = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    return await clearMain(ID, dir);
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
}

function present(dir: string): boolean {
  return (
    stateDb(dir).query("SELECT 1 FROM launches WHERE id = ?").get(ID) !== null
  );
}

describe("jig dispatch clear", () => {
  it("keeps an ended record, which the tick settles", async () => {
    const dir = root();
    writeRecord(record(), dir);
    recordExit(
      ID,
      { at: "2026-01-01T01:00:00.000Z", code: 0, signal: null },
      dir,
    );
    expect(await clear(dir)).toBe(2);
    expect(present(dir)).toBe(true);
  });

  const workspace = { id: "w", path: "/w" };
  const failed = {
    at: "2026-01-01T00:00:01.000Z",
    outcome: "failed" as const,
    detail: "x",
  };

  it("keeps a pending record whose launch can still be retried", async () => {
    const dir = root();
    writeRecord(record({ workspace }), dir);
    expect(await clear(dir)).toBe(2);
    expect(present(dir)).toBe(true);
  });

  it("keeps a pending record after one lost attempt, which can still be replayed", async () => {
    const dir = root();
    writeRecord(record({ workspace, attempts: [failed] }), dir);
    expect(await clear(dir)).toBe(2);
    expect(present(dir)).toBe(true);
  });

  it("clears a pending record whose attempts are spent", async () => {
    const dir = root();
    writeRecord(record({ workspace, attempts: [failed, failed] }), dir);
    expect(await clear(dir)).toBe(0);
    expect(present(dir)).toBe(false);
  });

  it("clears a pending record whose last attempt was sent but never claimed", async () => {
    const dir = root();
    writeRecord(
      record({ workspace, attempts: [{ ...failed, outcome: "sent" }] }),
      dir,
    );
    expect(await clear(dir)).toBe(0);
    expect(present(dir)).toBe(false);
  });

  it("clears a pending record that never got a workspace", async () => {
    const dir = root();
    writeRecord(record(), dir);
    expect(await clear(dir)).toBe(0);
    expect(present(dir)).toBe(false);
  });

  it("refuses an unreadable record whose claim is alive", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const claim = {
      host: (await import("node:os")).hostname(),
      bootId: (await import("../lib/launches.ts")).bootId(),
      pid: process.pid,
      start: "",
      claimedAt: "2026-01-01T00:00:00.000Z",
    };
    const { ownIdentity } = await import("../lib/launches.ts");
    const own = await ownIdentity();
    stateDb(dir)
      .query("UPDATE launches SET record = 'not json', claim = ? WHERE id = ?")
      .run(JSON.stringify(own ?? claim), ID);
    if (own === null) return;
    expect(await clear(dir)).toBe(2);
    expect(present(dir)).toBe(true);
  });

  it("clears an unreadable record that nothing claimed", async () => {
    const dir = root();
    writeRecord(record(), dir);
    stateDb(dir)
      .query("UPDATE launches SET record = 'not json' WHERE id = ?")
      .run(ID);
    expect(await clear(dir)).toBe(0);
    expect(present(dir)).toBe(false);
  });
});
