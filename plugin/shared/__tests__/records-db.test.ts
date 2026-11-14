/**
 * A component's database through `shared/records/db.ts`: created at the
 * schema's version with its meta row, migrated forward, used as it is when a
 * newer copy migrated it additively, refused with both versions named when it
 * needs a newer reader, and reopened when its file is replaced.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  databaseInstance,
  type Migration,
  minimumReader,
  openDatabase,
  schemaVersion,
} from "../records/db.ts";

const root = mkdtempSync(join(tmpdir(), "records-db-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const dir = join(root, `db-${++n}`);
  mkdirSync(dir);
  return join(dir, "state.sqlite");
};

const V1: Migration = {
  additive: false,
  sql: "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
};
const V2_ADDITIVE: Migration = {
  additive: true,
  sql: "CREATE TABLE extras (id INTEGER PRIMARY KEY);",
};
const V2_BREAKING: Migration = {
  additive: false,
  sql: "ALTER TABLE things RENAME COLUMN name TO label;",
};

/** A connection of the test's own, outside the module's cache. */
function raw(path: string): Database {
  return new Database(path);
}

function meta(path: string) {
  const db = raw(path);
  try {
    return db
      .query("SELECT instance, version, min_reader FROM db_meta WHERE id = 1")
      .get() as { instance: string; version: number; min_reader: number };
  } finally {
    db.close();
  }
}

describe("minimumReader", () => {
  it("is the version of the last migration that was not additive", () => {
    expect(minimumReader([V1], 1)).toBe(1);
    expect(minimumReader([V1, V2_ADDITIVE], 2)).toBe(1);
    expect(minimumReader([V1, V2_BREAKING], 2)).toBe(2);
    expect(minimumReader([V1, V2_BREAKING, V2_ADDITIVE], 3)).toBe(2);
    expect(minimumReader([V1], 0)).toBe(0);
  });
});

describe("openDatabase", () => {
  it("creates a database at the schema's version, in WAL, owner-only, with its meta row", () => {
    const path = fresh();
    const opened = openDatabase({ path, migrations: [V1, V2_ADDITIVE] });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(schemaVersion(path)).toBe(2);
    expect(opened.value.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(meta(path)).toMatchObject({ version: 2, min_reader: 1 });
    expect(databaseInstance(opened.value)).toMatch(/^[0-9a-f-]{36}$/);
    if (process.platform !== "win32")
      expect(statSync(path).mode & 0o777).toBe(0o600);
    closeDatabase(path);
  });

  it("migrates an older database forward and records the new minimum reader", () => {
    const path = fresh();
    expect(openDatabase({ path, migrations: [V1] }).ok).toBe(true);
    closeDatabase(path);
    const instance = meta(path).instance;
    expect(openDatabase({ path, migrations: [V1, V2_BREAKING] }).ok).toBe(true);
    closeDatabase(path);
    expect(schemaVersion(path)).toBe(2);
    expect(meta(path)).toMatchObject({ instance, version: 2, min_reader: 2 });
  });

  it("is used as it is by an older copy when the newer one only added", () => {
    const path = fresh();
    expect(openDatabase({ path, migrations: [V1, V2_ADDITIVE] }).ok).toBe(true);
    closeDatabase(path);
    const older = openDatabase({ path, migrations: [V1] });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    older.value.run("INSERT INTO things (name) VALUES ('kept')");
    closeDatabase(path);
    // Not migrated back, and the meta row still describes version 2.
    expect(schemaVersion(path)).toBe(2);
    expect(meta(path)).toMatchObject({ version: 2, min_reader: 1 });
  });

  it("is refused by an older copy, naming both versions, when it needs a newer reader", () => {
    const path = fresh();
    expect(openDatabase({ path, migrations: [V1, V2_BREAKING] }).ok).toBe(true);
    closeDatabase(path);
    const older = openDatabase({ path, migrations: [V1] });
    expect(older.ok).toBe(false);
    if (older.ok) return;
    expect(older.failure.code).toBe("newer-schema");
    expect(older.failure.reason).toContain("state schema version 2");
    expect(older.failure.reason).toContain("reader of version 2 or later");
    expect(older.failure.reason).toContain("this plugin knows version 1");
    expect(schemaVersion(path)).toBe(2);
  });

  it("refuses a newer version whose meta row was written for another version", () => {
    const path = fresh();
    expect(openDatabase({ path, migrations: [V1] }).ok).toBe(true);
    closeDatabase(path);
    const db = raw(path);
    db.run("PRAGMA user_version = 2");
    db.close();
    const opened = openDatabase({ path, migrations: [V1] });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.failure.code).toBe("newer-schema");
  });

  it("refuses a newer database written before minimum readers were recorded", () => {
    const path = fresh();
    const db = new Database(path, { create: true });
    db.run(V1.sql);
    db.run("PRAGMA user_version = 5");
    db.close();
    const opened = openDatabase({ path, migrations: [V1] });
    expect(opened.ok).toBe(false);
  });

  it("writes the meta row into a current database written before it had one", () => {
    const path = fresh();
    const db = new Database(path, { create: true });
    db.run(V1.sql);
    db.run("PRAGMA user_version = 1");
    db.close();
    expect(openDatabase({ path, migrations: [V1] }).ok).toBe(true);
    closeDatabase(path);
    expect(meta(path)).toMatchObject({ version: 1, min_reader: 1 });
  });

  it("refuses, on a held connection, a database another process migrated incompatibly", () => {
    const path = fresh();
    expect(openDatabase({ path, migrations: [V1] }).ok).toBe(true);
    const other = new Database(path);
    other.run("PRAGMA user_version = 3");
    other.run("UPDATE db_meta SET version = 3, min_reader = 3");
    other.close();
    const again = openDatabase({ path, migrations: [V1] });
    expect(again.ok).toBe(false);
    closeDatabase(path);
  });

  it("migrates a held connection when another schema is asked for", () => {
    const path = fresh();
    expect(openDatabase({ path, migrations: [V1] }).ok).toBe(true);
    const wider = openDatabase({ path, migrations: [V1, V2_ADDITIVE] });
    expect(wider.ok).toBe(true);
    expect(schemaVersion(path)).toBe(2);
    closeDatabase(path);
  });

  it("uses a requested nonblocking timeout before migrating a held connection", () => {
    const path = fresh();
    expect(openDatabase({ path, migrations: [V1] }).ok).toBe(true);
    const lock = raw(path);
    try {
      lock.exec("BEGIN IMMEDIATE");
      const began = performance.now();
      const wider = openDatabase({
        path,
        migrations: [V1, V2_ADDITIVE],
        busyMs: 0,
      });
      expect(performance.now() - began).toBeLessThan(1_000);
      expect(wider.ok).toBe(false);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      closeDatabase(path);
    }
  });

  it("reopens a database whose file was replaced, under another instance", () => {
    const path = fresh();
    const first = openDatabase({ path, migrations: [V1] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = databaseInstance(first.value);
    rmSync(path);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    const again = openDatabase({ path, migrations: [V1] });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(databaseInstance(again.value)).not.toBe(before);
    closeDatabase(path);
  });

  it("reports a path it cannot open as unopenable", () => {
    const blocker = fresh();
    expect(openDatabase({ path: blocker, migrations: [V1] }).ok).toBe(true);
    closeDatabase(blocker);
    const opened = openDatabase({
      path: join(blocker, "inside.sqlite"),
      migrations: [V1],
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.failure.code).toBe("unopenable");
  });
});
