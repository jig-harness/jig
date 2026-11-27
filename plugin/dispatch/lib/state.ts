/**
 * The dispatcher's state database, `~/.local/state/jig/dispatch/state.sqlite`
 * (`bun:sqlite`): the records the tick joins, dedupes and queries, one table
 * each, every row under a unique key.
 *
 * | Table | One row per | Its key carries |
 * | --- | --- | --- |
 * | `launches` | session the dispatcher started | the record's id; its wrapper `claim`, `exit` and `result` each fill an empty column; a headless claim's pending supervisor and child identities are each acknowledged once by their owner; a pass that recorded `waits` has `result` `failed`, the time it waits until in `result_until` and what it waits for (a rate limit, or a follow-up's arm still pending) in `result_wait`; a pass that recorded `failed --decision` has the decision in `result_decision`, and reads as `parked` (`launch-result.ts`); a pickup's `refusal` is written with its `result`; `report`, the run's closing report, is replaced by each later one that passes the check; a drive's driver appends each round's pass session id to `sessions` |
 * | `account_startup` | vendor account configuration | its current sign-in or repeated startup failure and consecutive quick deaths |
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
 * | `pickup_holds` | repository and tracker item | the operator's login and time of the hold, kept until release |
 * | `log` | outcome row | each row once: it is written in the same transaction as what it records; its `target` column, the piece of work, is indexed with the repository; an ended row's closing-report `cause` and writer (`report_by`) are columns too |
 * | `tick_line` | the newest tick from the machine file | one row, replaced by each such tick: the line as it found it and its receipt, which `jig dispatch dashboard` reads |
 * | `reflection_findings` | finding the reflection route made of a recurring class | its id, derived from the repository, stage, class and week: the event as every append sends it, pending until the store reports it stored |
 * | `load_samples` | kind of launch and sample | the memory one running session of that kind used at one tick; only each kind's newest samples are kept (`load-samples.ts`) |
 * | `merge_reads` | repository and merged pull request in the follow-up window | the follow-up markers a tick last read on it, and the launch claims where an ended launch of this host's needed them, at its `updatedAt` then and as the forge login that read them; replaced by each read, removed by a write the tick makes on it |
 * | `merge_facts` | repository and directly verified merged pull request | immutable merged time, base branch and complete changed files, independent of follow-up activation; associations and edge release are read again each tick |
 * | `overlap_waits` | repository and wanted pickup waiting on overlap | since when it waited in tier 2 or 3, since when in tier 3, and when it was promoted past the bound; removed once it starts or is no longer wanted |
 * | `overlap_hotspots` | repository, day and file | in how many ticks of the day the file kept a pickup over the overlap bound |
 * | `allocation_charge` | pickup claim | its claim id: written once, in the claim's transaction; a replay inserts nothing |
 * | `allocation_week` | completed week | the week, written once by the next week's first tick and never rewritten |
 * | `allocation_lane_epoch` | weighted lane's ready or empty transition | an increasing sequence; the newest is the epochs' revision |
 * | `allocation_ranking` | repository | the newest ranking, replaced by each tick |
 * | `failures` | action, repository or tick scope that failed in a row | its failures in a row, the first and last failure's time, the last reason and the next try; removed by a success or once its action leaves the plan |
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
 *
 * A wrapper whose stage has ended is the one reader that still uses such a
 * database: from `enterAfterStage` on, its process opens it through the
 * shared module's `openKnownColumns`, naming `AFTER_STAGE_COLUMNS`, every
 * column the wrapper reads or writes once the stage is over (its own launch
 * row, read whole, and the `exit` it writes; the earlier follow-up launches
 * of its pull request; the thread samples, waiting episodes and claimed
 * items read with its record; the claim ends it settles; a steward run's
 * submitted flag). So an upgrade during a stage, past a step that was not additive,
 * still gets the stage's exit recorded, and the newer tick classes the
 * launch by it. Nothing else the dispatcher runs opens the database that way:
 * the tick, a claim and every reader that decides slots stay refused. A
 * future step that is not additive keeps those columns as they are, in
 * name and in meaning, or older wrappers' exits stop crossing it: their
 * open is refused as before, the wrapper says so with the stage's own exit
 * code, and the tick finds the launch's wrapper gone without an exit.
 */
import { type Database, SQLiteError } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  closeDatabase,
  type KnownColumns,
  type Migration,
  type OpenCode,
  openDatabase,
  openKnownColumns,
  openReadOnly,
  type ReadOnlyDatabase,
  schemaVersion,
} from "../../shared/records/db.ts";
import { stateRoot } from "../receipts.ts";
import { ALLOCATION_TABLES_SQL } from "./allocation-store.ts";
import { ExitError } from "../../shared/cli.ts";
import { USAGE_EXIT } from "../../shared/command-line.ts";
import { Defect, JigError } from "../../shared/errors.ts";
import type { Outcome } from "../../shared/outcome.ts";

/** The database's file name under the state directory. */
const STATE_FILE = "state.sqlite";

/** A release a person already took under its own decision stays theirs when it could join a group. */
export const RELEASES_ALREADY_TAKEN = `UPDATE release_needs
    SET taken_as = json_object('target', item, 'evidence', json_object('tag', tag))
    WHERE item IS NOT NULL AND taken_as IS NULL AND EXISTS (
      SELECT 1 FROM station_answers AS answer
      WHERE answer.repo = release_needs.repo AND answer.target = release_needs.item
        AND answer.key = 'release' AND answer.outcome = 'held'
    );`;

/**
 * Each entry moves the schema from its index to the next version; a new
 * database runs them all. A change to the schema adds an entry, says whether
 * it is additive, and never edits one a released plugin ran.
 */
/** The dispatcher schema's ordered migrations, shared with historical-schema fixtures. */
export const MIGRATIONS: readonly Migration[] = [
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
  {
    additive: true,
    sql: `
  CREATE TABLE load_samples (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    record TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  );
  CREATE INDEX load_samples_kind ON load_samples (kind, seq);
  `,
  },
  {
    additive: true,
    sql: `
  CREATE TABLE failures (
    repo TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    count INTEGER NOT NULL,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    next_at_ms INTEGER NOT NULL,
    PRIMARY KEY (repo, key)
  );
  `,
  },
  {
    additive: true,
    sql: `CREATE TABLE pickup_reads (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  },
  {
    additive: true,
    sql: `CREATE TABLE steward_runs (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, hash TEXT NOT NULL,
      at_ms INTEGER NOT NULL, digest TEXT NOT NULL, submitted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX steward_runs_repo ON steward_runs (repo, at_ms);
    CREATE TABLE steward_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL REFERENCES steward_runs(id),
      repo TEXT NOT NULL, value TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, effect TEXT, effect_at_ms INTEGER
    );
    CREATE INDEX steward_records_repo ON steward_records (repo, applied);`,
  },
  {
    // A pickup the repository's start rules refused (`pickup-hold.ts`): the reason and the item's `updatedAt` as the rules saw it, as JSON. Written with the result, by the same update.
    additive: true,
    sql: "ALTER TABLE launches ADD COLUMN refusal TEXT;",
  },
  {
    additive: true,
    sql: "ALTER TABLE launches ADD COLUMN result_until TEXT;",
  },
  {
    // A pickup claim is acknowledged at the tracker boundary. It must not
    // share the tick-owned record JSON: a tick can still be writing an older
    // snapshot when the pickup claims its item.
    additive: true,
    sql: `
  CREATE TABLE pickup_claims (
    launch TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    PRIMARY KEY (launch, item)
  );
  `,
  },
  {
    // The framed decision a follow-up's or pickup's pass recorded with its `failed` result (`framed-result.ts`), as JSON with its digest and time. Written with the result, by the same update.
    additive: true,
    sql: "ALTER TABLE launches ADD COLUMN result_decision TEXT;",
  },
  {
    // A person's answer to a need's station decision that the tick acted on, once (`station-answer-store.ts`): which answer, the option, what the step did, and, for a step that starts a session, the answer that session is handed.
    additive: true,
    sql: `
  CREATE TABLE station_answers (
    repo TEXT NOT NULL,
    target TEXT NOT NULL,
    key TEXT NOT NULL,
    digest TEXT NOT NULL,
    answer TEXT NOT NULL,
    author TEXT NOT NULL,
    option TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    outcome TEXT,
    detail TEXT,
    carry TEXT,
    consumed_by TEXT,
    PRIMARY KEY (repo, target, key, digest, answer)
  );
  `,
  },
  {
    // The next session's lookup of the answer it is handed (`takeCarried`): a target's carried answers no launch has taken, newest first.
    additive: true,
    sql: `
  CREATE INDEX station_answers_carry ON station_answers (repo, target, claimed_at)
    WHERE carry IS NOT NULL AND consumed_by IS NULL;
  `,
  },
  {
    // A discarded launch's give-back of the answer it took (`returnCarried`): the rows a launch record consumed.
    additive: true,
    sql: `
  CREATE INDEX station_answers_consumed ON station_answers (consumed_by)
    WHERE consumed_by IS NOT NULL;
  `,
  },
  {
    // When a tick that read a wake-up row's repository last succeeded after its last failure (`quietFailure`), and how many times a failure has ended that quiet (`recordFailure`). A row an earlier release wrote has none.
    additive: true,
    sql: `
    ALTER TABLE failures ADD COLUMN quiet_at TEXT;
    ALTER TABLE failures ADD COLUMN renewals INTEGER NOT NULL DEFAULT 0;
  `,
  },
  {
    // Whether a steward digest's output has been through the retention erasure (`eraseStewardOutput`); only unexamined expired rows are scanned.
    additive: true,
    sql: `
    ALTER TABLE steward_runs ADD COLUMN erased INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX steward_runs_unerased ON steward_runs (at_ms) WHERE erased = 0;
  `,
  },
  {
    // A run's closing report (`closing-report-store.ts`): the launch record keeps it whole, as JSON with who wrote it and when; the outcome log's ended row carries its cause and its writer as columns the dashboard filters on.
    additive: true,
    sql: `
    ALTER TABLE launches ADD COLUMN report TEXT;
    ALTER TABLE log ADD COLUMN cause TEXT;
    ALTER TABLE log ADD COLUMN report_by TEXT;
  `,
  },
  {
    // Child identities and an unresolved spawn handoff must hold slots even after wrapper death. Earlier readers ignore those fields.
    additive: false,
    sql: "SELECT 1;",
  },
  {
    // The notification channel a suppression record is of (`notice-records.ts`). A row an earlier release wrote, or a copy one release behind writes, is `orca-card`'s, the only channel there was; the table's key stays the repository and `key`, which a channel other than `orca-card` qualifies with its name.
    additive: true,
    sql: "ALTER TABLE notices ADD COLUMN channel TEXT NOT NULL DEFAULT 'orca-card';",
  },
  {
    // Channel-qualified host notices are read by channel and key prefix on every tick.
    additive: false,
    sql: "CREATE INDEX notices_channel_key ON notices (channel, key);",
  },
  {
    // A steward run's records by effect (`judgedMembers` reads the refused-open ones of the latest runs only).
    additive: true,
    sql: "CREATE INDEX steward_records_run_effect ON steward_records (run, effect);",
  },
  {
    // A drive's per-round pass session ids (`round-sessions.ts`), which its driver writes on the launch record as each pass starts, so a run is found in its vendor's transcripts.
    additive: true,
    sql: "ALTER TABLE launches ADD COLUMN sessions TEXT;",
  },
  {
    // What a `waits` result waits for (`launch-result.ts`), as JSON: a rate limit's reset, or a follow-up's arm still pending and which. Written with the result, by the same update; `NULL` on a wait written before it was kept, which is a rate limit's.
    additive: true,
    sql: "ALTER TABLE launches ADD COLUMN result_wait TEXT;",
  },
  {
    // The declared-priorities allocation records (`allocation-store.ts`): one charge per pickup claim, one row per completed week, each weighted lane's ready transitions, and each repository's newest ranking.
    additive: true,
    sql: ALLOCATION_TABLES_SQL,
  },
  {
    additive: true,
    sql: "CREATE TABLE merge_facts (repo TEXT NOT NULL, pr INTEGER NOT NULL, fact TEXT NOT NULL, PRIMARY KEY (repo, pr));",
  },
  {
    additive: true,
    sql: `ALTER TABLE launches ADD COLUMN release_tags TEXT;
    CREATE TABLE release_needs (
      repo TEXT NOT NULL,
      tag TEXT NOT NULL,
      launch TEXT NOT NULL,
      item TEXT,
      rerun_claimed INTEGER NOT NULL DEFAULT 0,
      tagged INTEGER NOT NULL DEFAULT 0,
      next_tag_check INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repo, tag),
      UNIQUE (repo, item)
    );`,
  },
  {
    // A process-owned checkout keeps its ended launch evidence after normal retention. Pruning must preserve that evidence, which an earlier writer does not do, so earlier readers are refused.
    additive: false,
    sql: `
    CREATE TABLE process_worktree_completions (
      id TEXT PRIMARY KEY,
      record TEXT NOT NULL,
      claim TEXT NOT NULL,
      exit TEXT NOT NULL
    );
  `,
  },
  {
    additive: true,
    sql: `ALTER TABLE release_needs ADD COLUMN taken_as TEXT;
    ${RELEASES_ALREADY_TAKEN}`,
  },
  {
    // The overlap walk's waits and the files that kept work over the overlap bound (`overlap-waits.ts`).
    additive: true,
    sql: `
    CREATE TABLE overlap_waits (repo TEXT NOT NULL, item TEXT NOT NULL, since_ms INTEGER NOT NULL, tier3_since_ms INTEGER, promoted_ms INTEGER, PRIMARY KEY (repo, item));
    CREATE TABLE overlap_hotspots (repo TEXT NOT NULL, day TEXT NOT NULL, path TEXT NOT NULL, ticks INTEGER NOT NULL, PRIMARY KEY (repo, day, path));
  `,
  },
  {
    additive: true,
    sql: `CREATE TABLE rearm_lock_needs (
      repo TEXT NOT NULL,
      pr INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      heartbeat TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (repo, pr)
    );`,
  },
  {
    additive: true,
    sql: `CREATE TABLE pickup_holds (
      repo TEXT NOT NULL,
      item TEXT NOT NULL,
      held_by TEXT NOT NULL,
      held_at TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      PRIMARY KEY (repo, item)
    );`,
  },
  {
    additive: true,
    sql: `CREATE TABLE account_startup (
      vendor TEXT NOT NULL,
      config_dir TEXT NOT NULL,
      problem TEXT CHECK (problem IN ('sign-in', 'breaker')),
      since TEXT,
      seen_at TEXT,
      working_at TEXT,
      death_history TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (vendor, config_dir)
    );`,
  },
  {
    additive: true,
    sql: `CREATE TABLE rearm_waits (
      repo TEXT NOT NULL,
      pr INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      since_ms INTEGER NOT NULL,
      PRIMARY KEY (repo, pr)
    );`,
  },
  {
    additive: true,
    sql: `ALTER TABLE pickup_holds ADD COLUMN wait_condition TEXT;
      ALTER TABLE pickup_holds ADD COLUMN resume_record TEXT;
      ALTER TABLE pickup_holds ADD COLUMN wait_cleared INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE pickup_holds ADD COLUMN wait_linked INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // The tag plan's state a follow-up recorded a release owed under (`release-needs.ts`).
    additive: true,
    sql: "ALTER TABLE release_needs ADD COLUMN plan_state TEXT;",
  },
  {
    // A need that left the line, with when, by whom and how (`need-leaves.ts`): the record "Settled recently" on the dashboard and `jig ask --settled` read.
    additive: true,
    sql: `
  CREATE TABLE need_leaves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    target TEXT NOT NULL,
    cause TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    value TEXT NOT NULL
  );
  CREATE INDEX need_leaves_at ON need_leaves (at_ms);
  `,
  },
  {
    // The settled list's read of answers a station held or refused, by time (`readSettled`): without it each tick scans every answer taken.
    additive: true,
    sql: `
  CREATE INDEX station_answers_unsettled ON station_answers (claimed_at)
    WHERE outcome IN ('held', 'refused');
  `,
  },
  {
    // The settled list's follow-up reads by occurrence identity (`readSettled`): each looks up the kept answers' rows by index, not by scanning the day.
    additive: true,
    sql: `
  CREATE INDEX need_leaves_occurrence ON need_leaves (json_extract(value, '$.occurrence'));
  CREATE INDEX station_answers_unsettled_answer ON station_answers (answer)
    WHERE outcome IN ('held', 'refused');
  `,
  },
  {
    // A person's request for one steward pass of a repository (`steward-requests.ts`): `jig send steward@… start` writes it, the tick takes it.
    additive: true,
    sql: `CREATE TABLE steward_requests (
      repo TEXT PRIMARY KEY,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL
    );`,
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

/**
 * A database whose migration history or source state this plugin refuses:
 * the cause of the usage exit `stateDb` refuses it with, beside
 * `StateVersionError`, so a command tells the database's refusal from any
 * other.
 */
class StateRefusedError extends JigError<"migration-history" | "source-state"> {
  override name = "StateRefusedError";
}

/**
 * Why the state database failed this process, when `error` is the
 * database's own failure: any error SQLite raises, a schema version this
 * plugin cannot read, a migration history or source it refuses, or a file it
 * could not open; `null` for any other error. A defect that reaches SQLite
 * (a statement that does not prepare, a constraint) reads as the database's
 * failure too: a schema out of step with its version fails the same way.
 */
export function stateDbFailure(error: unknown): string | null {
  if (error instanceof SQLiteError) return error.message;
  if (!(error instanceof ExitError || error instanceof Defect)) return null;
  const { cause } = error;
  return cause instanceof StateVersionError ||
    cause instanceof StateRefusedError ||
    cause instanceof SQLiteError
    ? error.message
    : null;
}

/**
 * The columns a wrapper reads and writes once its stage has ended, by table:
 * its own launch row, which it reads whole, with the `exit` it writes; the
 * earlier follow-up launches of its pull request it reads a wait from; the
 * thread samples, waiting episodes and claimed items read with its record;
 * the claim ends it settles; a steward run's submitted flag; and the log
 * rows a report it records rewrites (`refreshEnded`).
 */
const AFTER_STAGE_COLUMNS: KnownColumns = {
  account_startup: [
    "vendor",
    "config_dir",
    "problem",
    "since",
    "seen_at",
    "working_at",
    "death_history",
  ],
  launches: [
    "id",
    "repo",
    "action",
    "pr",
    "created_at",
    "record",
    "claim",
    "exit",
    "result",
    "result_at",
    "result_until",
    "result_wait",
    "result_next",
    "result_decision",
    "refusal",
    "report",
    "sessions",
  ],
  thread_samples: ["launch", "round", "threads", "at"],
  waiting_episodes: [
    "launch",
    "observed_at",
    "reset_at",
    "evidence",
    "last",
    "read_at",
  ],
  pickup_claims: ["launch", "item"],
  settled_ends: ["record", "at"],
  steward_runs: ["id", "submitted"],
  log: ["key", "seq", "cause", "report_by", "row"],
};

let afterStage = false;

/**
 * Mark this process as a wrapper whose stage has ended: from here on,
 * `stateDb` also uses a database whose minimum reader is newer than this
 * plugin, as long as it keeps `AFTER_STAGE_COLUMNS` (see the header). Only
 * the wrapper calls it, once its stage is over.
 */
export function enterAfterStage(): void {
  afterStage = true;
}

/** The database file under a state directory. */
export function statePath(root = stateRoot()): string {
  return join(root, STATE_FILE);
}

/**
 * The state database under `root`, opened once per process: created and
 * migrated to this plugin's schema when it is new or older, refused with
 * the usage exit (its cause a `StateVersionError`, `newerStateRefusal`) when
 * a newer plugin wrote it and it needs a newer reader, unless this process is
 * a wrapper past its stage and the database keeps the columns it touches
 * (`enterAfterStage`). A database that cannot
 * be opened at all is a defect here, carrying what the platform threw as its
 * cause and its message.
 */
export function stateDb(root = stateRoot()): Database {
  const path = statePath(root);
  const spec = { path, migrations: MIGRATIONS };
  const opened = afterStage
    ? openKnownColumns(spec, AFTER_STAGE_COLUMNS)
    : openDatabase(spec);
  if (opened.ok) return opened.value;
  const { code, reason, cause } = opened.failure;
  if (code === "migration-history" || code === "source-state")
    throw new ExitError(USAGE_EXIT, reason, {
      cause: new StateRefusedError(code, reason, { cause }),
    });
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
