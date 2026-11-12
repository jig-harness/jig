import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase, openReadOnly } from "../records/db.ts";

const root = mkdtempSync(join(tmpdir(), "records-history-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const first = {
  sql: "CREATE TABLE records (id INTEGER PRIMARY KEY);",
  additive: false,
};
const main = {
  sql: "ALTER TABLE records ADD COLUMN result_until TEXT;",
  additive: true,
};
const branch = {
  sql: "CREATE TABLE pickup_claims (id INTEGER PRIMARY KEY);",
  additive: true,
};

test("a legacy user table resembling SQLite's reserved prefix is still compared", () => {
  const path = join(root, "legacy-extra-prefix.sqlite");
  const db = new Database(path);
  db.run(first.sql);
  db.run("CREATE TABLE sqliteX_branch (id INTEGER)");
  db.run("PRAGMA user_version = 1");
  db.close();
  const opened = openDatabase({ path, migrations: [first] });
  expect(opened.ok).toBe(false);
  closeDatabase(path);
});

test("refuses divergent migration SQL at the same version, including cached and read-only opens", () => {
  const path = join(root, "collision.sqlite");
  expect(openDatabase({ path, migrations: [first, branch] }).ok).toBe(true);
  for (const open of [openDatabase, openReadOnly]) {
    const result = open({ path, migrations: [first, main] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toContain("migration 2");
  }
  closeDatabase(path);
  expect(openDatabase({ path, migrations: [first, main] }).ok).toBe(false);
});

test("a legacy collision is refused without stamping or repairing it", () => {
  const path = join(root, "legacy-collision.sqlite");
  const db = new Database(path);
  db.run(first.sql);
  db.run(branch.sql);
  db.run("PRAGMA user_version = 2");
  for (const open of [openDatabase, openReadOnly]) {
    const result = open({ path, migrations: [first, main] });
    expect(result.ok).toBe(false);
  }
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE name = 'db_migrations'")
      .get(),
  ).toBeNull();
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  db.close();
});

test("schema-verified legacy baselines preserve rows and refuse later SQL divergence", () => {
  const path = join(root, "legacy.sqlite");
  const db = new Database(path);
  db.run(first.sql);
  db.run("INSERT INTO records VALUES (41)");
  db.run("PRAGMA user_version = 1");
  db.close();
  const opened = openDatabase({ path, migrations: [first, main] });
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  expect(opened.value.query("SELECT id FROM records").all()).toEqual([
    { id: 41 },
  ]);
  expect(
    opened.value
      .query("SELECT version, evidence FROM db_migrations ORDER BY version")
      .all(),
  ).toEqual([
    { version: 1, evidence: "schema" },
    { version: 2, evidence: "applied" },
  ]);
  closeDatabase(path);
  expect(
    openDatabase({
      path,
      migrations: [{ ...first, sql: first.sql + " -- changed" }, main],
    }).ok,
  ).toBe(false);
});
