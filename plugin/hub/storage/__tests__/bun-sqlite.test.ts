/**
 * The storage contract on `bun:sqlite` in write-ahead-log mode, the process
 * adapter's store: each test opens a fresh database file with the hub's
 * migrations applied, and a second connection to the same file for the
 * races.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSY_TIMEOUT_MS, openHubSqlite } from "../../process/sqlite.ts";
import { createStorage } from "../storage.ts";
import { type StorageHarness, storageContract } from "./contract.ts";

const scratch = mkdtempSync(join(tmpdir(), "hub-storage-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let opened = 0;

function open(path: string) {
  const sqlite = openHubSqlite(path);
  if (!sqlite.ok) throw new Error(sqlite.failure.reason);
  return sqlite.value;
}

storageContract("bun:sqlite", (): StorageHarness => {
  const path = join(scratch, `hub-${++opened}.sqlite`);
  const first = open(path);
  const more: Array<{ close(): void }> = [];
  return {
    storage: createStorage(first.db),
    connect: () => {
      const next = open(path);
      more.push(next);
      return createStorage(next.db);
    },
    close: () => {
      for (const connection of more) connection.close();
      first.close();
    },
  };
});

test("the process adapter's database is in write-ahead-log mode with its migrations applied", () => {
  const sqlite = open(join(scratch, "modes.sqlite"));
  try {
    const client = sqlite.client;
    expect(client.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(client.query("PRAGMA busy_timeout").get()).toEqual({
      timeout: BUSY_TIMEOUT_MS,
    });
    expect(
      client
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('in_flight_reads', 'job_leases') ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(["in_flight_reads", "job_leases"]);
  } finally {
    sqlite.close();
  }
});

test("a closed database answers unavailable, not a throw", async () => {
  const sqlite = open(join(scratch, "closed.sqlite"));
  const storage = createStorage(sqlite.db);
  sqlite.close();
  const { readJob } = await import("../../core/operations.ts");
  const answer = await storage.run(
    {
      unit: "test:closed",
      signal: new AbortController().signal,
      deadlineAt: 0,
    },
    "directory",
    readJob,
    { job: "sweep" },
  );
  expect(answer.ok ? null : answer.failure.code).toBe("unavailable");
});

test("a file that cannot be opened answers unavailable", () => {
  const answer = openHubSqlite(join(scratch, "no-such-dir", "hub.sqlite"));
  expect(answer.ok ? null : answer.failure.code).toBe("unavailable");
});
