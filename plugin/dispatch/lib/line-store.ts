/**
 * The newest tick's line in the state database (`tick_line`, one row): what
 * `jig dispatch dashboard` shows above the log, and that tick's receipt. It is
 * a table rather than a file so a host that serves the dashboard from a copy
 * of the database has it with no other read: launch states, walls, accounts
 * and titles all come from records only the tick can reach.
 *
 * `stateAnswer` is the one read of it for everything outside the tick: the
 * dashboard's `GET /state` and `jig dispatch line --json` both answer with it,
 * so the two never say different things about one database.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isMapping } from "../../shared/config-layers.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { pluginVersion } from "../../shared/plugin-version.ts";
import { isSpan, isTime, isZone } from "../../shared/time-guards.ts";
import { stateRoot } from "../receipts.ts";
import type { LineSnapshot, StateAnswer } from "./dashboard-contract.ts";
import { hostTimeZone } from "./host-time.ts";
import { SCHEMA_VERSION, stateDb, statePath } from "./state.ts";

/** Replace the stored line with this tick's. */
export function writeLine(
  line: LineSnapshot,
  receipt: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `INSERT INTO tick_line (id, run_id, line, receipt) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         run_id = excluded.run_id, line = excluded.line, receipt = excluded.receipt`,
    )
    .run(line.runId, JSON.stringify(line), receipt);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const nullOr =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === null || check(value);

type Fields = Record<string, (value: unknown) => boolean>;

/** Whether `value` is a mapping whose listed fields each pass their check. */
function hasFields(value: unknown, fields: Fields): boolean {
  return (
    isMapping(value) &&
    Object.entries(fields).every(([name, check]) => check(value[name]))
  );
}

/** Whether `value` is a list every entry of which has the listed fields. */
function listOf(fields: Fields): (value: unknown) => boolean {
  return (value) =>
    Array.isArray(value) && value.every((entry) => hasFields(entry, fields));
}

/** What the needs view reads of each decision. */
const DECISION_FIELDS: Fields = {
  person: (value) => value === undefined || isString(value),
  key: isString,
  kind: (value) => value === "thread" || value === "finding",
  lines: (value) => Array.isArray(value) && value.every(isString),
  question: nullOr(isString),
  recommendation: nullOr(isString),
  decisionClass: nullOr(isString),
};

/** What the sessions view reads of each thread sample. */
const SAMPLE_FIELDS: Fields = {
  round: isNumber,
  threads: isNumber,
  at: isString,
};

/** The fields every reader of a collection's entries relies on; the rest of an entry is the tick's own detail. */
const ENTRY_FIELDS = {
  needs: {
    cause: isString,
    repo: isString,
    target: isString,
    since: isTime,
    reason: isString,
    question: (value) =>
      value === undefined || value === null || isString(value),
    decisions: listOf(DECISION_FIELDS),
    workspaces: Array.isArray,
    workspace: (value) =>
      value === undefined || value === null || isString(value),
  },
  sessions: {
    record: isString,
    account: isString,
    repo: isString,
    target: isString,
    createdAt: isTime,
    samples: listOf(SAMPLE_FIELDS),
  },
  accounts: {
    name: isString,
    vendor: isString,
    cap: isNumber,
    held: isNumber,
  },
  queue: { repo: isString, target: isString, why: isString },
  repos: {
    path: isString,
    stages: Array.isArray,
    failedReads: Array.isArray,
    notes: Array.isArray,
  },
} satisfies Record<string, Fields>;

/** Whether `value` is a mapping of phase names to milliseconds. */
const isPhases = (value: unknown): boolean =>
  isMapping(value) && Object.values(value).every(isNumber);

/** What the tick strip reads of each recent tick. */
const TICK_FIELDS: Fields = {
  runId: isString,
  startedAt: isTime,
  tookMs: isNumber,
  exitStatus: isNumber,
  sweep: (value) => typeof value === "boolean",
  phasesMs: isPhases,
  repos: listOf({
    repo: isString,
    ms: isNumber,
    phasesMs: isPhases,
    defect: nullOr(isString),
  }),
  budget: nullOr((value) =>
    hasFields(value, { remaining: isNumber, limit: isNumber }),
  ),
  busy: (value) => Array.isArray(value) && value.every(isString),
  lowBudget: nullOr((value) => Array.isArray(value) && value.every(isString)),
  defects: isNumber,
};

const LINE_FIELDS: Fields = {
  runId: isString,
  startedAt: isTime,
  finishedAt: isTime,
  exitStatus: isNumber,
  apply: (value) => typeof value === "boolean",
  applyWithheld: nullOr(isString),
  intervalMs: isNumber,
  longestTickMs: isNumber,
  recentTicksMs: (value) =>
    value === undefined || (Array.isArray(value) && value.every(isNumber)),
  ticks: (value) => value === undefined || listOf(TICK_FIELDS)(value),
  plugin: nullOr(isString),
  timeZone: (value) => value === undefined || isZone(value),
  lastAccount: nullOr(isString),
  needs: listOf(ENTRY_FIELDS.needs),
  sessions: listOf(ENTRY_FIELDS.sessions),
  accounts: listOf(ENTRY_FIELDS.accounts),
  queue: listOf(ENTRY_FIELDS.queue),
  ready: (value) =>
    value === undefined ||
    listOf({
      repo: isString,
      pr: isNumber,
      url: isString,
      head: isString,
      place: isString,
      lane: nullOr(isString),
      says: isString,
      act: nullOr(isString),
      command: nullOr(isString),
      requested: Array.isArray,
      failing: Array.isArray,
      conditions: Array.isArray,
      unblocks: Array.isArray,
    })(value),
  repos: listOf(ENTRY_FIELDS.repos),
};

/** Whether the spans the page adds to the tick's start (and to each other) stay times it can show; `value` has passed `LINE_FIELDS`. */
function hasSpans(line: Record<string, unknown>): boolean {
  const startedAt = line.startedAt as string;
  const interval = line.intervalMs as number;
  const longest = line.longestTickMs as number;
  return (
    isSpan(startedAt, interval) &&
    isSpan(startedAt, longest) &&
    isSpan(startedAt, interval + longest)
  );
}

/** Whether `value` has the shape of a `LineSnapshot` the dashboard and `jig dispatch line --json` pass on. */
function isLine(value: unknown): value is LineSnapshot {
  return (
    isMapping(value) &&
    value.version === 1 &&
    hasFields(value, LINE_FIELDS) &&
    hasSpans(value)
  );
}

type Stored = { runId: string; line: string; receipt: string };

/** A database a newer plugin wrote that this copy cannot read. */
class NewerSchemaError extends Error {}

/** Refuse a database a newer plugin wrote that needs a newer reader, as the shared opener does. */
function refuseNewer(db: Database, path: string): void {
  const { user_version: version } = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version <= SCHEMA_VERSION) return;
  const meta = db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'",
    )
    .get()
    ? (db
        .query("SELECT version, min_reader FROM db_meta WHERE id = 1")
        .get() as { version: number; min_reader: number } | null)
    : null;
  const minReader =
    meta !== null && meta.version === version ? meta.min_reader : version;
  if (minReader > SCHEMA_VERSION)
    throw new NewerSchemaError(
      `${path} is at state schema version ${version}, which needs a reader of version ${minReader} or later; this plugin knows version ${SCHEMA_VERSION}`,
    );
}

/**
 * The stored row, read through a read-only connection: opening the state
 * database for writing would migrate an older schema and take SQLite's write
 * lock, which a reader polling beside the tick must not. A database with no
 * `tick_line` table (a schema before it) holds no line yet.
 */
function stored(root: string): Stored | null {
  const path = statePath(root);
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    refuseNewer(db, path);
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("tick_line");
    if (table === null) return null;
    return (
      (db
        .query(
          "SELECT run_id AS runId, line, receipt FROM tick_line WHERE id = 1",
        )
        .get() as Stored | null | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

/** The stored line; `null` before a tick wrote one. */
export function readLine(
  root = stateRoot(),
): Outcome<LineSnapshot | null, "line-unreadable"> {
  const row = attempt(
    "line-unreadable",
    "the newest tick's line cannot be read",
    () => stored(root),
  );
  if (!row.ok) return row;
  if (row.value === null) return ok(null);
  const { line } = row.value;
  const parsed = attempt(
    "line-unreadable",
    "the newest tick's line is not JSON",
    (): unknown => JSON.parse(line),
  );
  if (!parsed.ok) return parsed;
  return isLine(parsed.value)
    ? ok(parsed.value)
    : failed(
        "line-unreadable",
        "the newest tick's line is not in a form this plugin reads; the next tick writes it again",
      );
}

/**
 * The newest tick's line with the reader's own facts (its clock, its plugin,
 * the schema it reads): what `GET /state` answers and `jig dispatch line
 * --json` prints. `line` is `null` before a tick wrote one, and when there is
 * no state database yet, which this read never creates.
 */
export function stateAnswer(
  nowMs: number,
  root = stateRoot(),
): Outcome<StateAnswer, "line-unreadable"> {
  const line = readLine(root);
  if (!line.ok) return line;
  return ok({
    now: new Date(nowMs).toISOString(),
    timeZone: line.value?.timeZone ?? hostTimeZone(),
    plugin: pluginVersion(),
    schema: SCHEMA_VERSION,
    line: line.value,
  });
}

/** The receipt of the tick that wrote the stored line, with that tick's run; `null` before a tick wrote one. One row is read, so the two always belong together. */
export function readLineReceipt(
  root = stateRoot(),
): Outcome<{ runId: string; receipt: string } | null, "line-unreadable"> {
  return attempt(
    "line-unreadable",
    "the newest tick's receipt cannot be read",
    () => {
      const row = stored(root);
      return row === null ? null : { runId: row.runId, receipt: row.receipt };
    },
  );
}
