/**
 * The dispatcher's state database, `~/.local/state/jig/dispatch/state.sqlite`
 * (`bun:sqlite`): the records the tick joins, dedupes and queries, one table
 * each, every row under a unique key.
 *
 * | Table | One row per | Its key carries |
 * | --- | --- | --- |
 * | `launches` | session the dispatcher started | the record's id; its `claim`, `exit` and `result` are each written once, by an update that only fills an empty column |
 * | `thread_samples` | drive and ledger round | the count recorded the first tick that sees the round |
 * | `waiting_episodes` | interactive session and wall | a later wall is a new episode, the same one is read again |
 * | `notices` | repository and notification cause | once per cause, until the cause goes |
 * | `nudges` | session and waiting episode | one nudge per episode, its delivery marked once |
 * | `followup_outcomes` | repository and merged pull request | the latest attempt's outcome |
 * | `idle` | repository and claimed item | the stall clock starts once |
 * | `log` | outcome row | each row once: it is written in the same transaction as what it records |
 *
 * The receipts, the account walls (which the drive's quota adapters write
 * from a pass, outside the tick), the tick lock and the rotation cursor stay
 * files, and the outcome log keeps a text copy, one JSONL file per month
 * (`log-export.ts`).
 *
 * The database is opened in WAL mode, so `jig dispatch dashboard` and
 * `jig dispatch log` read while a tick writes. Ticks write one at a time,
 * under the tick lock; the wrapper's claim and exit and a session's result
 * are single statements SQLite's own write lock orders, each waiting up to
 * `BUSY_MS` for a transaction in progress.
 *
 * Its schema has a version (`PRAGMA user_version`): a database at an older
 * one is migrated forward, one entry of `MIGRATIONS` per version, in one
 * transaction; one a newer plugin wrote is refused, with its version named.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../receipts.ts";

/** The database's file name under the state directory. */
const STATE_FILE = "state.sqlite";

/** How long a write waits for another connection's transaction to end. */
const BUSY_MS = 10_000;

/**
 * Each entry moves the schema from its index to the next version; a new
 * database runs them all. A change to the schema adds an entry and never
 * edits one a released plugin ran.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE launches (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    action TEXT NOT NULL,
    pr INTEGER,
    item TEXT,
    created_at TEXT NOT NULL,
    record TEXT NOT NULL,
    claim TEXT,
    exit TEXT,
    result TEXT CHECK (result IN ('done', 'failed')),
    result_at TEXT
  );
  CREATE TABLE thread_samples (
    launch TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    threads INTEGER NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (launch, round)
  );
  CREATE TABLE waiting_episodes (
    launch TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    reset_at TEXT,
    evidence TEXT NOT NULL,
    last INTEGER NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (launch, observed_at)
  );
  CREATE TABLE notices (
    repo TEXT NOT NULL,
    key TEXT NOT NULL,
    target TEXT NOT NULL,
    workspace TEXT NOT NULL,
    at TEXT NOT NULL,
    lasting INTEGER NOT NULL,
    PRIMARY KEY (repo, key)
  );
  CREATE TABLE nudges (
    record TEXT NOT NULL,
    episode TEXT NOT NULL,
    repo TEXT NOT NULL,
    target TEXT NOT NULL,
    account TEXT NOT NULL,
    at TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('pending', 'delivered', 'unknown')),
    detail TEXT NOT NULL,
    PRIMARY KEY (record, episode)
  );
  CREATE INDEX nudges_repo ON nudges (repo);
  CREATE TABLE followup_outcomes (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    record TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('done', 'failed')),
    at TEXT NOT NULL,
    created TEXT NOT NULL,
    PRIMARY KEY (repo, pr)
  );
  CREATE TABLE idle (
    repo TEXT NOT NULL,
    item TEXT NOT NULL,
    since INTEGER NOT NULL,
    PRIMARY KEY (repo, item)
  );
  CREATE TABLE log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    repo TEXT NOT NULL,
    stage TEXT NOT NULL,
    account TEXT,
    bucket TEXT NOT NULL,
    reason TEXT NOT NULL,
    row TEXT NOT NULL
  );
  CREATE INDEX log_at ON log (at_ms);
  CREATE TABLE log_export (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL
  );
  `,
];

/** The schema version this plugin writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** A database this plugin cannot use: a newer plugin wrote it. */
export class StateVersionError extends Error {
  readonly path: string;
  readonly version: number;
  constructor(path: string, version: number) {
    super(
      `${path} is at state schema version ${version}, which a newer plugin wrote; this plugin knows version ${SCHEMA_VERSION}. Update the plugin, or move the file aside to start a new one`,
    );
    this.name = "StateVersionError";
    this.path = path;
    this.version = version;
  }
}

function userVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

/** Bring the schema to `SCHEMA_VERSION`, refusing a newer one, in one transaction. */
function migrate(db: Database, path: string): void {
  db.transaction(() => {
    // Read again under the write lock: another process may have migrated it.
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) throw new StateVersionError(path, version);
    for (let v = version; v < SCHEMA_VERSION; v++)
      db.run(MIGRATIONS[v] as string);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}

const connections = new Map<string, Database>();

/** The database file under a state directory. */
export function statePath(root = stateRoot()): string {
  return join(root, STATE_FILE);
}

/**
 * The state database under `root`, opened once per process: created and
 * migrated to this plugin's schema when it is new or older, refused
 * (`StateVersionError`) when a newer plugin wrote it.
 */
export function stateDb(root = stateRoot()): Database {
  const path = statePath(root);
  const open = connections.get(path);
  if (open !== undefined) return open;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(path);
  const db = new Database(path, { create: true });
  try {
    if (fresh) chmodSync(path, 0o600);
    db.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) throw new StateVersionError(path, version);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    if (version < SCHEMA_VERSION) migrate(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
  connections.set(path, db);
  return db;
}

/** Close and forget the connection to the state database under `root`, when this process holds one. */
export function closeStateDb(root = stateRoot()): void {
  const path = statePath(root);
  connections.get(path)?.close();
  connections.delete(path);
}

/** The state database under `root` when it exists; `null` before the first tick created it. A reader never creates it. */
export function existingStateDb(root = stateRoot()): Database | null {
  return existsSync(statePath(root)) ? stateDb(root) : null;
}

/** Run `fn` in one write transaction: everything it writes lands, or none of it does. */
export function inTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}
