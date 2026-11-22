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
import { Database, SQLiteError } from "bun:sqlite";
import { Defect } from "../../../shared/outcome.ts";
import { readJob } from "../../core/operations.ts";
import {
  BUSY_TIMEOUT_MS,
  classifyBunSqlite,
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
    storage: createStorage(first.db, first),
    racer: {
      script: new URL("./bun-sqlite-racer.ts", import.meta.url),
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

test("a corrupt stored progress cell is a defect, never progress to resume from", async () => {
  const sqlite = open(join(scratch, "corrupt.sqlite"));
  try {
    const storage = createStorage(sqlite.db, sqlite);
    sqlite.client.run(
      "INSERT INTO job_leases (partition, job, progress, started_at, updated_at) VALUES ('directory', 'sweep', 'not json', 0, 0)",
    );
    await expect(
      storage.run(
        { unit: "test", signal: new AbortController().signal, deadlineAt: 0 },
        "directory",
        readJob,
        { job: "sweep" },
      ),
    ).rejects.toBeInstanceOf(Defect);
  } finally {
    sqlite.close();
  }
});

test("the bun:sqlite classifier reads errors by type and code", () => {
  // bun:sqlite alone constructs its errors, so these are its own.
  const thrownBy = (statement: string): unknown => {
    const client = new Database(":memory:");
    try {
      client.run("CREATE TABLE t (a TEXT NOT NULL)");
      client.run(statement);
      return null;
    } catch (error) {
      return error;
    } finally {
      client.close();
    }
  };
  const constraint = thrownBy("INSERT INTO t VALUES (NULL)");
  const other = thrownBy("SELECT * FROM no_such_table");
  expect(constraint).toBeInstanceOf(SQLiteError);
  expect(other).toBeInstanceOf(SQLiteError);
  const open = classifyBunSqlite(() => false);
  const closed = classifyBunSqlite(() => true);
  expect(open(constraint)).toBe("refused");
  expect(open(new Error("wrapped", { cause: constraint }))).toBe("refused");
  expect(open(other)).toBe("defect");
  expect(open(new Error("wrapped", { cause: other }))).toBe("defect");
  const holder = new Database(join(scratch, "busy.sqlite"), { create: true });
  const waiter = new Database(join(scratch, "busy.sqlite"));
  holder.run("CREATE TABLE b (x)");
  holder.run("BEGIN EXCLUSIVE");
  let busy: unknown;
  try {
    waiter.run("INSERT INTO b VALUES (1)");
  } catch (error) {
    busy = error;
  } finally {
    holder.close();
    waiter.close();
  }
  expect((busy as SQLiteError).code).toBe("SQLITE_BUSY");
  expect(open(new Error("wrapped", { cause: busy }))).toBe("unavailable");
  expect(open(new RangeError("Cannot use a closed database"))).toBe("defect");
  expect(closed(new RangeError("Cannot use a closed database"))).toBe(
    "unavailable",
  );
  expect(open(new TypeError("a bug"))).toBe("defect");
  expect(open(new Error("CONSTRAINT in a message only"))).toBe("defect");
});

test("a file that cannot be opened answers unavailable", () => {
  const answer = openHubSqlite(join(scratch, "no-such-dir", "hub.sqlite"));
  expect(answer.ok ? null : answer.failure.code).toBe("unavailable");
});
