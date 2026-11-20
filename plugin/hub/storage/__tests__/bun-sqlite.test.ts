/**
 * The storage contract on `bun:sqlite` in write-ahead-log mode, the process
 * adapter's store: each test opens a fresh database file with the hub's
 * migrations applied, and the races open their own connections to the same
 * file from worker threads (`bun-sqlite-racer.ts`).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORD_KINDS } from "../../../shared/records/registry.ts";
import { HUB_SCHEMA } from "../../../shared/records/registry-hub.ts";
import {
  BUSY_TIMEOUT_MS,
  MIGRATIONS_FOLDER,
  openHubSqlite,
} from "../../process/sqlite.ts";
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
  return {
    storage: createStorage(first.db),
    racer: {
      script: join(import.meta.dir, "bun-sqlite-racer.ts"),
      data: { path },
    },
    close: () => first.close(),
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
    // Every table the migrations create is a registered kind of the hub
    // medium, at the schema version the migrations reach.
    const tables = client
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    const registered = RECORD_KINDS.filter((k) => k.medium === "hub");
    expect(registered.map((k) => k.table).sort()).toEqual(tables);
    const journal: { entries: unknown[] } = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
    );
    expect(journal.entries).toHaveLength(HUB_SCHEMA);
    for (const kind of registered) expect(kind.version).toBe(HUB_SCHEMA);
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
