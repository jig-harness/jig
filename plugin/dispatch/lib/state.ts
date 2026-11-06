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
 * | `notices` | repository and notification cause | once per cause, until the cause goes; its first send, and its last, which a repeat is timed from |
 * | `notices_content` | workspace | the exact dispatcher-only comment last confirmed, and the intended write awaiting an exact read |
 * | `notices_read` | repository | when the tick first found its notices workspace read, until it is unread again or removed |
 * | `nudges` | session and waiting episode | one nudge per episode, its delivery marked once |
 * | `followup_outcomes` | repository and merged pull request | the latest attempt's outcome |
 * | `followup_releases` | repository and merged pull request | the one stale claim the tick released, pending until the forge deleted its marker |
 * | `idle` | repository and claimed item | the stall clock starts once |
 * | `holds` | repository and pull request held behind another in a serialized area | the hold's start, written with its event row |
 * | `log` | outcome row | each row once: it is written in the same transaction as what it records; its `target` column, the piece of work, is indexed with the repository |
 * | `tick_line` | the newest tick from the machine file | one row, replaced by each such tick: the line as it found it and its receipt, which `jig dispatch dashboard` reads |
 *
 * The receipts, the account walls (which the drive's quota adapters write
 * from a pass, outside the tick), the tick lock and the rotation cursor stay
 * files, and the outcome log keeps a text copy, one JSONL file per month
 * (`log-export.ts`).
 *
 * The database is opened through the shared `shared/records/db.ts`, in WAL
 * mode, so `jig dispatch dashboard` and `jig dispatch log` read while a tick
 * writes. Ticks write one at a time, under the tick lock; the wrapper's claim
 * and exit and a session's result are single statements SQLite's own write
 * lock orders, each waiting for a transaction in progress.
 *
 * Its schema has a version (`PRAGMA user_version`): a database at an older
 * one is migrated forward, one entry of `MIGRATIONS` per version, in one
 * transaction. One a newer plugin migrated is used as it is when every step
 * past this plugin's version was additive, and refused, with its version
 * named, when it needs a newer reader (the shared module's minimum reader).
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  closeDatabase,
  type Migration,
  openDatabase,
  schemaVersion,
} from "../../shared/records/db.ts";
import { stateRoot } from "../receipts.ts";

/** The database's file name under the state directory. */
const STATE_FILE = "state.sqlite";

/**
 * Each entry moves the schema from its index to the next version; a new
 * database runs them all. A change to the schema adds an entry, says whether
 * it is additive, and never edits one a released plugin ran.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    additive: false,
    sql: `
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
  },
  {
    additive: true,
    sql: `
  CREATE INDEX launches_created ON launches (created_at);
  `,
  },
  {
    additive: true,
    sql: `
  CREATE TABLE holds (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    area TEXT NOT NULL,
    leader INTEGER NOT NULL,
    since TEXT NOT NULL,
    PRIMARY KEY (repo, pr)
  );
  `,
  },
  {
    additive: true,
    sql: `
  CREATE TABLE tick_line (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT NOT NULL,
    line TEXT NOT NULL,
    receipt TEXT NOT NULL
  );
  `,
  },
  {
    additive: true,
    sql: `
  CREATE TABLE settled_ends (
    record TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );
  `,
  },
  {
    additive: true,
    sql: `
  CREATE TABLE notices_read (
    repo TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    since INTEGER NOT NULL
  );
  `,
  },
  {
    additive: true,
    sql: `CREATE TABLE notices_content (
      workspace TEXT PRIMARY KEY,
      comment TEXT NOT NULL
    );`,
  },
  {
    additive: true,
    sql: "ALTER TABLE notices_content ADD COLUMN repo TEXT;",
  },
  {
    // The piece of work a row is about, so one key's rows are one lookup.
    // A copy one release behind writes rows without it; a reader of one key
    // also reads those (`log.ts`, `rowsFor`).
    additive: true,
    sql: `
  ALTER TABLE log ADD COLUMN target TEXT;
  UPDATE log SET target = json_extract(row, '$.target');
  CREATE INDEX log_target ON log (repo, target, at_ms);
  `,
  },
  {
    // When a notice was last sent, which its repeat is timed from; `at`
    // stays its first send. A row without it was sent once, at `at`.
    additive: true,
    sql: "ALTER TABLE notices ADD COLUMN sent_at TEXT;",
  },
  {
    additive: true,
    sql: `
  CREATE TABLE followup_releases (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    marker INTEGER NOT NULL,
    login TEXT NOT NULL,
    claimant TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    released_at TEXT,
    PRIMARY KEY (repo, pr)
  );
  `,
  },
  {
    additive: true,
    sql: "ALTER TABLE notices_content ADD COLUMN pending TEXT;",
  },
];

/** The schema version this plugin writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** A database this plugin cannot use: a newer plugin wrote it, and it needs a newer reader. */
export class StateVersionError extends Error {
  readonly path: string;
  readonly version: number;
  constructor(path: string, version: number, reason: string) {
    super(reason);
    this.name = "StateVersionError";
    this.path = path;
    this.version = version;
  }
}

/** The database file under a state directory. */
export function statePath(root = stateRoot()): string {
  return join(root, STATE_FILE);
}

/**
 * The state database under `root`, opened once per process: created and
 * migrated to this plugin's schema when it is new or older, refused
 * (`StateVersionError`) when a newer plugin wrote it and it needs a newer
 * reader. A database that cannot be opened at all is a defect here, as it
 * always was: what the platform threw is thrown.
 */
export function stateDb(root = stateRoot()): Database {
  const path = statePath(root);
  const opened = openDatabase({ path, migrations: MIGRATIONS });
  if (opened.ok) return opened.value;
  const { code, reason, cause } = opened.failure;
  if (code === "newer-schema")
    throw new StateVersionError(path, schemaVersion(path) ?? 0, reason);
  throw cause instanceof Error ? cause : new Error(reason);
}

/** Close and forget the connection to the state database under `root`, when this process holds one. */
export function closeStateDb(root = stateRoot()): void {
  closeDatabase(statePath(root));
}

/** The state database under `root` when it exists; `null` before the first tick created it. A reader never creates it. */
export function existingStateDb(root = stateRoot()): Database | null {
  return existsSync(statePath(root)) ? stateDb(root) : null;
}

/** Run `fn` in one write transaction: everything it writes lands, or none of it does. */
export { inTransaction } from "../../shared/records/db.ts";
