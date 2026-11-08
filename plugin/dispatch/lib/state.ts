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
 * | `followup_outcomes` | repository and merged pull request | the latest attempt's outcome, with the question its pass stopped on and that question's routine class |
 * | `followup_releases` | repository and merged pull request | the one stale claim the tick released, pending until the forge deleted its marker |
 * | `idle` | repository and claimed item | the stall clock starts once |
 * | `holds` | repository and pull request held behind another in a serialized area | the hold's start, written with its event row |
 * | `log` | outcome row | each row once: it is written in the same transaction as what it records; its `target` column, the piece of work, is indexed with the repository |
 * | `tick_line` | the newest tick from the machine file | one row, replaced by each such tick: the line as it found it and its receipt, which `jig dispatch dashboard` reads |
 * | `reflection_findings` | finding the reflection route made of a recurring class | its id, derived from the repository, stage, class and week: the event as every append sends it, pending until the store reports it stored |
 * | `merge_reads` | repository and merged pull request in the follow-up window | the follow-up markers a tick last read on it, and the launch claims where an ended launch of this host's needed them, at its `updatedAt` then and as the forge login that read them; replaced by each read, removed by a write the tick makes on it |
 *
 * The receipts, the account walls (which the drive's quota adapters write
 * from a pass, outside the tick), the tick's locks and the rotation cursor stay
 * files, and the outcome log keeps a text copy, one JSONL file per month
 * (`log-export.ts`).
 *
 * The database is opened through the shared `shared/records/db.ts`, in WAL
 * mode, so `jig dispatch dashboard` and `jig dispatch log` read while a tick
 * writes. Ticks act one at a time, under the act lock; a tick's observe
 * phase writes only rows of the repositories it holds the observe lock of,
 * and the wrapper's claim and exit and a session's result are single
 * statements, all of which SQLite's own write lock orders, each waiting for
 * a transaction in progress.
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
  type OpenCode,
  openDatabase,
  openReadOnly,
  type ReadOnlyDatabase,
  schemaVersion,
} from "../../shared/records/db.ts";
import { stateRoot } from "../receipts.ts";
import { ExitError } from "../../shared/cli.ts";
import { USAGE_EXIT } from "../../shared/command-line.ts";
import { Defect, JigError } from "../../shared/errors.ts";
import type { Outcome } from "../../shared/outcome.ts";

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
  {
    additive: true,
    sql: `
  CREATE TABLE reflection_findings (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    stage TEXT NOT NULL,
    class TEXT NOT NULL,
    week TEXT NOT NULL,
    event TEXT NOT NULL,
    at TEXT NOT NULL,
    stored_at TEXT,
    ref TEXT
  );
  CREATE INDEX reflection_findings_repo ON reflection_findings (repo, stored_at);
  `,
  },
  {
    additive: true,
    sql: `
  CREATE TABLE merge_reads (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    read_at_ms INTEGER NOT NULL,
    login TEXT,
    markers TEXT NOT NULL,
    claims TEXT,
    claims_read_at_ms INTEGER,
    PRIMARY KEY (repo, pr)
  );
  `,
  },
  { additive: true, sql: "ALTER TABLE launches ADD COLUMN result_next TEXT;" },
  {
    // What a follow-up's question was and its routine class (`followup-outcomes.ts`), as JSON naming the record it is of. A row an earlier release wrote has none.
    additive: true,
    sql: "ALTER TABLE followup_outcomes ADD COLUMN asked TEXT;",
  },
];

/** The schema version this plugin writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * A database this plugin cannot use: a newer plugin wrote it, and it needs a
 * newer reader. It is the cause of the usage exit `stateDb` refuses the
 * database with, so a command tells that refusal from any other.
 */
class StateVersionError extends JigError<"newer-schema"> {
  override name = "StateVersionError";
  readonly path: string;
  readonly version: number;
  constructor(path: string, version: number, reason: string) {
    super("newer-schema", reason);
    this.path = path;
    this.version = version;
  }
}

/** Why the state database was refused, when `error` is `stateDb`'s refusal of one a newer plugin wrote; `null` for anything else. */
export function newerStateRefusal(error: unknown): string | null {
  return error instanceof ExitError && error.cause instanceof StateVersionError
    ? error.cause.message
    : null;
}

/** The database file under a state directory. */
export function statePath(root = stateRoot()): string {
  return join(root, STATE_FILE);
}

/**
 * The state database under `root`, opened once per process: created and
 * migrated to this plugin's schema when it is new or older, refused with
 * the usage exit (its cause a `StateVersionError`, `newerStateRefusal`) when
 * a newer plugin wrote it and it needs a newer reader. A database that cannot
 * be opened at all is a defect here, carrying what the platform threw as its
 * cause and its message.
 */
export function stateDb(root = stateRoot()): Database {
  const path = statePath(root);
  const opened = openDatabase({ path, migrations: MIGRATIONS });
  if (opened.ok) return opened.value;
  const { code, reason, cause } = opened.failure;
  if (code === "newer-schema")
    throw new ExitError(USAGE_EXIT, reason, {
      cause: new StateVersionError(path, schemaVersion(path) ?? 0, reason),
    });
  throw new Defect(cause instanceof Error ? cause.message : reason, { cause });
}

/** Close and forget the connection to the state database under `root`, when this process holds one. */
export function closeStateDb(root = stateRoot()): void {
  closeDatabase(statePath(root));
}

/** The state database under `root` when it exists; `null` before the first tick created it. A reader never creates it. */
export function existingStateDb(root = stateRoot()): Database | null {
  return existsSync(statePath(root)) ? stateDb(root) : null;
}

/**
 * The state database under `root` opened read-only, for a reader that is not
 * the dispatcher (`jig ask`): it creates and migrates nothing, so an older
 * schema stays as it is until a tick brings it forward, and it takes no write
 * lock. `null` when there is no database. The caller closes the connection.
 */
export function readOnlyStateDb(
  root = stateRoot(),
): Outcome<ReadOnlyDatabase | null, OpenCode> {
  return openReadOnly({ path: statePath(root), migrations: MIGRATIONS });
}

/** Run `fn` in one write transaction: everything it writes lands, or none of it does. */
export { inTransaction } from "../../shared/records/db.ts";
