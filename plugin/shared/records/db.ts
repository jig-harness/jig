/**
 * One component's SQLite database on the machine (`bun:sqlite`): how it is
 * opened, how its schema moves forward, and which plugin copies may read it.
 *
 * Each component that keeps machine records in SQLite (the dispatcher's
 * `dispatch/lib/state.ts`, the drive's `skills/drive-pr/scripts/lib/state/db.ts`)
 * opens its own database through `openDatabase`, never one shared by all, so a
 * component's migration never waits on another's. Every connection runs in
 * write-ahead-log mode, so a reader never waits on a writer; waits up to
 * `BUSY_MS` for another connection's transaction to end; and enforces foreign
 * keys. A new database's directory is created owner-only (`0700`) and the file
 * itself `0600`.
 *
 * **Versions.** A schema is a list of migrations: entry `i` moves the schema
 * from version `i` to `i + 1`, and a new database runs them all, in one
 * transaction, under SQLite's write lock (two copies opening a database at
 * once migrate it once). A change to a schema adds an entry and never edits
 * one a released plugin ran. The version is `PRAGMA user_version`.
 * Migration digests distinguish histories at the same version. Legacy
 * databases are structurally verified before a baseline is recorded; that
 * baseline does not prove which SQL or data changes previously ran.
 *
 * **The minimum reader.** A database also records, in its `db_meta` row, the
 * lowest schema version a reader must know to use it. Each migration declares
 * whether it is `additive`: it only adds a table, an index, or a column with a
 * default, so a copy that knows the version before it still reads and writes
 * everything it knows. The minimum reader of version N is the highest version
 * at or below N whose migration was not additive (the first migration, which
 * creates the schema, never is). So a plugin copy one release behind keeps
 * using a database a newer copy migrated additively, ignoring what it does not
 * know and running no migration of its own, and refuses one only when the
 * schema needs a reader newer than itself, naming both versions. A meta row
 * written for another version than the database is at says nothing about it,
 * and neither does a missing one (a database written before minimum readers
 * were recorded): the minimum reader is then the database's own version, so
 * only a copy that knows that version reads it.
 *
 * **The instance.** The meta row also holds a random id minted when the row
 * is first written. A database deleted and created again, or another file put
 * in its place, has another id, so a process handed a database's id by its
 * parent can tell it is still talking to the same one.
 *
 * Opening returns an `Outcome`
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)); a throw out
 * of a migration's SQL is a defect in the plugin, not in the database.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { swallow } from "../errors.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import {
  baselineMigrations,
  needsHistory,
  recordMigration,
  verifyMigrations,
} from "./migrations.ts";
import { sourceDatabaseRefusal } from "./source.ts";
import { currentIso } from "../time.ts";

/** How long a write waits for another connection's transaction to end. */
const BUSY_MS = 10_000;

/** One step of a schema: the SQL that moves it one version forward. */
export interface Migration {
  readonly sql: string;
  /**
   * Whether a reader that knows only the previous version still uses the
   * database after this step: it adds tables, indexes or columns with
   * defaults, and changes or removes nothing such a reader reads.
   */
  readonly additive: boolean;
}

/** A component's database: where it lives and its schema. */
export interface DatabaseSpec {
  readonly path: string;
  readonly migrations: readonly Migration[];
}

/** Why a database could not be opened. */
export type OpenCode =
  | "newer-schema"
  | "unopenable"
  | "migration-history"
  | "source-state";

/** The meta row: the instance id, and the version and minimum reader it was written for. */
const META = `
CREATE TABLE IF NOT EXISTS db_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance TEXT NOT NULL,
  version INTEGER NOT NULL,
  min_reader INTEGER NOT NULL,
  created_at TEXT NOT NULL
)`;

interface MetaRow {
  instance: string;
  version: number;
  min_reader: number;
}

/** The lowest version a reader must know to use a database at `version` of this schema. */
export function minimumReader(
  migrations: readonly Migration[],
  version: number,
): number {
  let floor = Math.min(1, version);
  for (let i = 1; i < Math.min(version, migrations.length); i++)
    if (!migrations[i]?.additive) floor = i + 1;
  return floor;
}

function userVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

function hasMeta(db: Database): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'",
      )
      .get() !== null
  );
}

function metaRow(db: Database): MetaRow | null {
  if (!hasMeta(db)) return null;
  return db
    .query("SELECT instance, version, min_reader FROM db_meta WHERE id = 1")
    .get() as MetaRow | null;
}

/** The minimum reader a database at `version` records, by the rule in the header. */
function recordedMinimum(db: Database, version: number): number {
  const meta = metaRow(db);
  return meta !== null && meta.version === version ? meta.min_reader : version;
}

/** The refusal of a database this copy cannot read, or `null` when it can. */
function refusal(
  db: Database,
  spec: DatabaseSpec,
): Outcome<never, OpenCode> | null {
  const version = userVersion(db);
  const known = spec.migrations.length;
  if (version <= known) {
    const verified = verifyMigrations(db, spec, version);
    return verified.ok ? null : verified;
  }
  const minReader = recordedMinimum(db, version);
  if (minReader <= known) {
    const verified = verifyMigrations(db, spec, version);
    return verified.ok ? null : verified;
  }
  return failed(
    "newer-schema",
    `${spec.path} is at state schema version ${version}, which a newer plugin wrote and which needs a reader of version ${minReader} or later; this plugin knows version ${known}. Update the plugin, or move the file aside to start a new one`,
  );
}

/**
 * Bring the schema to this copy's version, or leave a newer one as it is,
 * and keep the meta row current, in one write transaction: the version is
 * read again under the write lock, since another process may have migrated
 * it first.
 */
function migrate(db: Database, spec: DatabaseSpec): Outcome<null, OpenCode> {
  return db
    .transaction((): Outcome<null, OpenCode> => {
      const refused = refusal(db, spec);
      if (refused !== null) return refused;
      const known = spec.migrations.length;
      const version = userVersion(db);
      baselineMigrations(db, spec, version);
      for (let v = version; v < known; v++) {
        const migration = spec.migrations[v] as Migration;
        db.run(migration.sql);
        recordMigration(db, migration, v + 1);
      }
      const now = Math.max(version, known);
      if (now !== version) db.run(`PRAGMA user_version = ${now}`);
      db.run(META);
      const meta = metaRow(db);
      if (meta === null)
        db.run(
          "INSERT INTO db_meta (id, instance, version, min_reader, created_at) VALUES (1, ?, ?, ?, ?)",
          [
            randomUUID(),
            now,
            minimumReader(spec.migrations, now),
            currentIso(),
          ],
        );
      else if (meta.version !== now && now <= known)
        db.run("UPDATE db_meta SET version = ?, min_reader = ? WHERE id = 1", [
          now,
          minimumReader(spec.migrations, now),
        ]);
      return ok(null);
    })
    .immediate();
}

/** Whether the database needs a write before it is current: a migration, or its meta row. */
function needsWrite(db: Database, spec: DatabaseSpec): boolean {
  const version = userVersion(db);
  if (needsHistory(db, version)) return true;
  if (version < spec.migrations.length) return true;
  if (version > spec.migrations.length) return false;
  const meta = metaRow(db);
  return meta === null || meta.version !== version;
}

/** The compatibility decision and its write requirement read one SQLite snapshot. */
function inspectDatabase(
  db: Database,
  spec: DatabaseSpec,
): {
  readonly refusal: Outcome<never, OpenCode> | null;
  readonly write: boolean;
} {
  return db.transaction(() => {
    const refused = refusal(db, spec);
    return {
      refusal: refused,
      write: refused === null && needsWrite(db, spec),
    };
  })();
}

interface Open {
  db: Database;
  dev: number;
  ino: number;
}

const connections = new Map<string, Open>();

/** The file's identity, or `null` when it is gone. */
function fileId(path: string): { dev: number; ino: number } | null {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    swallow(err, "the database file could not be stat'ed");
    return null;
  }
}

/** The connection this process already holds to `path`, while the file is still the one it opened. */
function cached(path: string): Database | null {
  const open = connections.get(path);
  if (open === undefined) return null;
  const now = fileId(path);
  if (now !== null && now.dev === open.dev && now.ino === open.ino)
    return open.db;
  open.db.close();
  connections.delete(path);
  return null;
}

function connect(spec: DatabaseSpec): Outcome<Database, OpenCode> {
  const fresh = !existsSync(spec.path);
  let db: Database;
  try {
    mkdirSync(dirname(spec.path), { recursive: true, mode: 0o700 });
    db = new Database(spec.path, { create: true });
    if (fresh) chmodSync(spec.path, 0o600);
    db.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
  } catch (error) {
    return failed(
      "unopenable",
      `${spec.path} cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  try {
    const inspected = inspectDatabase(db, spec);
    if (inspected.refusal !== null) {
      db.close();
      return inspected.refusal;
    }
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    if (inspected.write) {
      const migrated = migrate(db, spec);
      if (!migrated.ok) {
        db.close();
        return migrated;
      }
    }
  } catch (error) {
    db.close();
    return failed(
      "unopenable",
      `${spec.path} cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  return ok(db);
}

/** Re-check a held connection after another process or caller changed its schema. */
function refreshConnection(
  db: Database,
  spec: DatabaseSpec,
): Outcome<Database, OpenCode> {
  try {
    const inspected = inspectDatabase(db, spec);
    if (inspected.refusal !== null) return inspected.refusal;
    if (inspected.write) {
      const migrated = migrate(db, spec);
      if (!migrated.ok) return migrated;
    }
    return ok(db);
  } catch (error) {
    return failed(
      "unopenable",
      `${spec.path} cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * The database at `spec.path`, opened once per process: created and migrated
 * to this copy's schema when it is new or older, used as it is when a newer
 * copy migrated it additively, refused (`newer-schema`, its reason naming
 * the database's version, the reader it needs and this copy's) when it needs
 * a newer reader. A connection is reopened when the file it was opened on has
 * been removed or replaced.
 */
export function openDatabase(spec: DatabaseSpec): Outcome<Database, OpenCode> {
  const sourceRefusal = sourceDatabaseRefusal(spec.path);
  if (sourceRefusal !== null) return sourceRefusal;
  const reused = cached(spec.path);
  if (reused !== null) return refreshConnection(reused, spec);
  const opened = connect(spec);
  if (!opened.ok) return opened;
  const id = fileId(spec.path);
  if (id !== null) connections.set(spec.path, { db: opened.value, ...id });
  return opened;
}

/** A database opened for reading only, and whether its owner's next open would write to it. */
export interface ReadOnlyDatabase {
  readonly db: Database;
  /** The schema version the file is at. */
  readonly version: number;
  /** Whether opening it through `openDatabase` would migrate it or write its meta row. */
  readonly behind: boolean;
}

/**
 * The database at `spec.path` opened read-only, for a reader that must not
 * choose when its owner's database migrates: nothing is created, migrated or
 * written, and the connection is the caller's to close. `null` when there is
 * no file. A database a newer plugin wrote that needs a newer reader is
 * refused (`newer-schema`) as `openDatabase` refuses it; an older one is
 * returned as it is, `behind` set, for the caller to read what its schema
 * holds.
 */
export function openReadOnly(
  spec: DatabaseSpec,
): Outcome<ReadOnlyDatabase | null, OpenCode> {
  const sourceRefusal = sourceDatabaseRefusal(spec.path);
  if (sourceRefusal !== null) return sourceRefusal;
  if (!existsSync(spec.path)) return ok(null);
  let db: Database | undefined;
  try {
    db = new Database(spec.path, { readonly: true });
    db.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
    const inspected = inspectDatabase(db, spec);
    if (inspected.refusal !== null) {
      db.close();
      return inspected.refusal;
    }
    return ok({
      db,
      version: userVersion(db),
      behind: inspected.write,
    });
  } catch (error) {
    db?.close();
    return failed(
      "unopenable",
      `${spec.path} cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/** Close and forget this process's connection to `path`, when it holds one. */
export function closeDatabase(path: string): void {
  connections.get(path)?.db.close();
  connections.delete(path);
}

/** The schema version of the database at `path`, read without migrating it; `null` when it cannot be read. */
export function schemaVersion(path: string): number | null {
  if (sourceDatabaseRefusal(path) !== null) return null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      return userVersion(db);
    } finally {
      db.close();
    }
  } catch (err) {
    swallow(err, "the database's schema version could not be read");
    return null;
  }
}

/** The database's instance id: random, minted with its meta row. */
export function databaseInstance(db: Database): string {
  return metaRow(db)?.instance ?? "";
}

/** Run `fn` in one write transaction: everything it writes lands, or none of it does. */
export function inTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}
