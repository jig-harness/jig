/** Migration identities and the structural baseline for databases predating them. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { failed, ok, type Outcome } from "../outcome.ts";
import type { DatabaseSpec, Migration } from "./db.ts";

const TABLE = `CREATE TABLE IF NOT EXISTS db_migrations (
  version INTEGER PRIMARY KEY,
  digest TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (evidence IN ('schema', 'applied'))
)`;

function digest(migration: Migration): string {
  return createHash("sha256")
    .update(JSON.stringify([migration.sql, migration.additive]))
    .digest("hex");
}

function hasHistory(db: Database): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_migrations'",
      )
      .get() !== null
  );
}

interface Step {
  version: number;
  digest: string;
}
function steps(db: Database): Step[] | null {
  return hasHistory(db)
    ? (db
        .query("SELECT version, digest FROM db_migrations ORDER BY version")
        .all() as Step[])
    : null;
}

/** Completeness is decided from the same snapshot whose digests were checked. */
function incomplete(
  recorded: readonly Step[] | null,
  version: number,
): boolean {
  return (
    recorded === null ||
    recorded.length !== version ||
    recorded.some((step, i) => step.version !== i + 1)
  );
}

export function needsHistory(db: Database, version: number): boolean {
  return incomplete(steps(db), version);
}

/** SQLite's own normalized DDL includes columns, constraints, indexes, views and triggers. */
function schema(db: Database): string {
  return JSON.stringify(
    db
      .query(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('db_meta', 'db_migrations')
    ORDER BY type, name`)
      .all(),
  );
}

/** Check every known recorded identity; missing history requires a structural comparison. */
export function verifyMigrations(
  db: Database,
  spec: DatabaseSpec,
  version: number,
): Outcome<null, "migration-history"> {
  const recorded = steps(db);
  for (const step of recorded ?? []) {
    const expected = spec.migrations[step.version - 1];
    if (
      step.version < 1 ||
      step.version > version ||
      (expected && digest(expected) !== step.digest)
    )
      return failed(
        "migration-history",
        `${spec.path}: migration ${step.version} differs from this plugin's migration history; leave the database unchanged and ask its operator to reconcile the histories`,
      );
  }
  if (!incomplete(recorded, version)) return ok(null);
  if (version > spec.migrations.length)
    return failed(
      "migration-history",
      `${spec.path}: migration history is incomplete at version ${version}; open it with the newer plugin that knows its full schema before using this copy`,
    );
  const expected = new Database(":memory:");
  try {
    for (const migration of spec.migrations.slice(0, version))
      expected.run(migration.sql);
    if (schema(db) !== schema(expected))
      return failed(
        "migration-history",
        `${spec.path}: legacy schema at version ${version} differs from this plugin's migrations; leave the database unchanged and ask its operator to reconcile the schemas`,
      );
    return ok(null);
  } finally {
    expected.close();
  }
}

/** Called under the migration write lock, after verification and before running new SQL. */
export function baselineMigrations(
  db: Database,
  spec: DatabaseSpec,
  version: number,
): void {
  db.run(TABLE);
  for (let i = 0; i < Math.min(version, spec.migrations.length); i++)
    db.run("INSERT OR IGNORE INTO db_migrations VALUES (?, ?, 'schema')", [
      i + 1,
      digest(spec.migrations[i] as Migration),
    ]);
}

/** The SQL and its identity are committed in the same transaction. */
export function recordMigration(
  db: Database,
  migration: Migration,
  version: number,
): void {
  db.run("INSERT INTO db_migrations VALUES (?, ?, 'applied')", [
    version,
    digest(migration),
  ]);
}
