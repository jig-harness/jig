/**
 * The drive's database: one SQLite file per machine,
 * `~/.local/state/jig/drive-pr/state.sqlite` (under `$DRIVE_PR_STATE_DIR` when
 * it is set), opened through the shared `shared/records/db.ts`, so it has the
 * shared module's write-ahead log, busy wait, migrations and minimum reader.
 *
 * Every row is keyed by the clone it belongs to: the clone key
 * (`clone-key.ts`), which is also the name of that clone's state directory
 * beside the database, `<root>/<clone key>/`. That directory keeps what is not
 * a record other code queries: the driver log, the kept answers and the long
 * pass notice (`pass-handoff.ts`), the arm output, the morning report's
 * memory and, on Windows, a driver's process registry. A function that is
 * handed a clone's state directory therefore reaches the database beside it
 * and the clone it names, which is what `driveDb` resolves.
 *
 * | Table | One row per | What it replaces |
 * | --- | --- | --- |
 * | `drive_state` | clone and pull request: the `DriveState` document as JSON, with its schema version | `drive-pr-<PR>.json` |
 * | `locks` | clone and lock name: its holder's process identity, token and heartbeat | the store mutex and its tombstones, the driver locks, the remote-mutation lock, the tree-lease guard |
 * | `leases` | clone, pull request and working tree: the session lease | `pr-drive-lease-<PR>-wt-<hex>.json` |
 * | `tree_leases` | clone and working tree: the tree lease | `drive-tree-lease-wt-<hex>.json` |
 * | `claims` | clone, pull request, kind and key: a held item's or the Ready mark's claim token | `drive-pr-<PR>.held-claim.*`, `.ready-claim` |
 * | `stops` | nothing this release writes: an earlier release's stop requests; a stop is now a mailbox directive addressed to a driver generation (`mailbox.ts`), and the table stays so that release still opens the database | `stop.<nonce>`, `.stop-complete.<nonce>.json` |
 * | `driver_records` | clone and pull request: the driver a stop by signal leaves for recovery | `ledger-driver-<PR>.json` |
 * | `imports` | clone: when its state directory's files were read in | the migration scripts and markers |
 * | `counters` | name: a number that only grows, such as the lease generation or a pull request's driver generation | — |
 * | `review_rounds` | clone, pull request and head: the review round that head was counted as (`review-rounds.ts`) | the review loop's counter in the working tree's Git directory |
 *
 * A clone's state directory written by an earlier release is read into these
 * rows once, at the first open that finds no `imports` row for the clone
 * (`import.ts`), and its files are left where they are.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { swallow } from "../../../../../shared/errors.ts";
import {
  databaseInstance,
  inTransaction,
  type Migration,
  openDatabase,
} from "../../../../../shared/records/db.ts";
import { fail } from "../cli.ts";
import { importStateDir } from "./import.ts";

/** The database's file name, in the state root. */
export const DB_FILE = "state.sqlite";

/** Each entry moves the schema one version forward; see `shared/records/db.ts`. */
const MIGRATIONS: readonly Migration[] = [
  {
    additive: false,
    sql: `
  CREATE TABLE drive_state (
    clone TEXT NOT NULL,
    pr TEXT NOT NULL,
    v INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (clone, pr)
  );
  CREATE TABLE locks (
    clone TEXT NOT NULL,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    label TEXT NOT NULL,
    pid INTEGER NOT NULL,
    host_id TEXT NOT NULL,
    host TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    start TEXT NOT NULL,
    platform TEXT NOT NULL,
    detail TEXT,
    acquired_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL,
    PRIMARY KEY (clone, name)
  );
  CREATE TABLE leases (
    clone TEXT NOT NULL,
    pr TEXT NOT NULL,
    actor TEXT NOT NULL,
    holder TEXT NOT NULL CHECK (holder IN ('session', 'worktree')),
    pid INTEGER NOT NULL,
    host_id TEXT NOT NULL,
    host TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    start TEXT NOT NULL,
    platform TEXT NOT NULL,
    worktree TEXT NOT NULL,
    command TEXT NOT NULL,
    session_started TEXT NOT NULL,
    generation INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (clone, pr, actor)
  );
  CREATE TABLE tree_leases (
    clone TEXT NOT NULL,
    actor TEXT NOT NULL,
    pr TEXT NOT NULL,
    revision TEXT NOT NULL,
    holder TEXT NOT NULL CHECK (holder IN ('session', 'worktree')),
    pid INTEGER NOT NULL,
    host_id TEXT NOT NULL,
    host TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    start TEXT NOT NULL,
    platform TEXT NOT NULL,
    worktree TEXT NOT NULL,
    command TEXT NOT NULL,
    session_started TEXT NOT NULL,
    generation INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (clone, actor)
  );
  CREATE TABLE claims (
    clone TEXT NOT NULL,
    pr TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('held', 'ready')),
    key TEXT NOT NULL,
    token TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (clone, pr, kind, key)
  );
  CREATE TABLE stops (
    clone TEXT NOT NULL,
    lock TEXT NOT NULL,
    nonce TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    completed_pid INTEGER,
    completed_at TEXT,
    PRIMARY KEY (clone, lock, nonce)
  );
  CREATE TABLE driver_records (
    clone TEXT NOT NULL,
    pr TEXT NOT NULL,
    worktree TEXT NOT NULL,
    started TEXT NOT NULL,
    pid INTEGER NOT NULL,
    host TEXT NOT NULL,
    released INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (clone, pr)
  );
  CREATE TABLE imports (
    clone TEXT PRIMARY KEY,
    dir TEXT NOT NULL,
    at TEXT NOT NULL,
    imported INTEGER NOT NULL,
    skipped TEXT NOT NULL
  );
  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  `,
  },
  {
    additive: true,
    sql: `
  CREATE INDEX leases_by_actor ON leases (clone, actor, pr);
  `,
  },
  {
    additive: true,
    sql: `
  CREATE TABLE review_rounds (
    clone TEXT NOT NULL,
    pr TEXT NOT NULL,
    head TEXT NOT NULL,
    round INTEGER NOT NULL,
    settled INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL,
    PRIMARY KEY (clone, pr, head)
  );
  `,
  },
];

/** The schema version this plugin writes. */
export const DRIVE_DB_VERSION = MIGRATIONS.length;

/** The database and the clone a clone's state directory stands for. */
export interface DriveDb {
  readonly db: Database;
  /** The clone key: the state directory's own name. */
  readonly clone: string;
  /** The database file. */
  readonly path: string;
}

/** Where the database a clone's state directory stands for lives. */
export function dbPathFor(stateDir: string): string {
  return join(dirname(stateDir), DB_FILE);
}

/**
 * The database beside `stateDir`, opened once per process, with the clone
 * `stateDir` names. The first open for a clone reads in the files an earlier
 * release left in its directory. A database a newer plugin needs a newer
 * reader for stops the command with exit 2, naming both versions; one that
 * cannot be opened at all, with exit 1.
 */
export function driveDb(stateDir: string): DriveDb {
  const path = dbPathFor(stateDir);
  const opened = openDatabase({ path, migrations: MIGRATIONS });
  if (!opened.ok)
    fail(
      opened.failure.code === "newer-schema" ? 2 : 1,
      `drive-state.ts: ${opened.failure.reason}`,
    );
  const drive = { db: opened.value, clone: basename(stateDir), path };
  try {
    importStateDir(drive, stateDir);
  } catch (error) {
    fail(
      1,
      `drive-state.ts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return drive;
}

/** What a clone's import recorded: when, and the files it could not read. */
export interface ImportRecord {
  readonly at: string;
  readonly skipped: readonly string[];
}

/**
 * The clone's import record, read without creating, migrating or importing
 * anything: `null` when there is no database, no `imports` row, a `skipped`
 * list that is not all strings, or the database cannot be read. For a dry run, which must leave the disk as it is.
 */
export function peekImport(stateDir: string): ImportRecord | null {
  const path = dbPathFor(stateDir);
  if (!existsSync(path)) return null;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (err) {
    swallow(err, "the drive's database could not be opened read-only");
    return null;
  }
  try {
    const row = db
      .query("SELECT at, skipped FROM imports WHERE clone = ?")
      .get(basename(stateDir)) as { at: string; skipped: string } | null;
    if (row === null) return null;
    const skipped: unknown = JSON.parse(row.skipped);
    // A damaged list is no record: the caller then keeps what it cannot vouch for.
    if (
      !Array.isArray(skipped) ||
      !skipped.every((s): s is string => typeof s === "string")
    )
      return null;
    return { at: row.at, skipped };
  } catch (err) {
    swallow(err, "the drive's import record could not be read");
    return null;
  } finally {
    db.close();
  }
}

/** The database's instance id: what a driver hands its passes so they can tell it is still the same database. */
export function driveDbInstance(stateDir: string): string {
  return databaseInstance(driveDb(stateDir).db);
}

/** The next value of counter `name`, which only grows: it survives every row it was written into being deleted. */
export function nextCount(drive: DriveDb, name: string): number {
  return inTransaction(drive.db, () => {
    const row = drive.db
      .query(
        "INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value",
      )
      .get(name) as { value: number };
    return row.value;
  });
}

export { inTransaction };
