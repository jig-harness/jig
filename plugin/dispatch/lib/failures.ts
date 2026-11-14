/**
 * The failure ledger, the state database's `failures` table: what failed in
 * a row, so a tick backs off an action that keeps failing and tells a
 * person once the count passes `failures.notify_after`. What is wanted stays
 * derived every tick ([ADR-0013](../../../docs/adr/ADR-0013-records-not-a-daemon.md)):
 * a row only remembers failures, never what to do. One row per key, keyed by
 * the repository and the key:
 *
 * | Kind | One row per | Its key | Backs off |
 * | --- | --- | --- | --- |
 * | `label` | pull request whose dispatch labels the projection writes | `label PR #<n>`, `label markers PR #<n>` for its markers | yes |
 * | `notice` | notification cause | `notice <its key>` | yes |
 * | `failure-notice` | notification of a failure below | `notice <its key>` | yes, and never notified itself |
 * | `nudge` | session and waiting episode | `nudge <record> <episode>` | yes |
 * | `claim-end` | this host's launch claim whose end is owed | `claim-end PR #<n> comment <id>` | yes |
 * | `marker-answer` | follow-up marker whose answer is owed | `marker-answer PR #<n> comment <id>` | yes |
 * | `repository` | repository whose turn failed (refused, a defect, a record that did not read) | `repository`, under its path | no |
 * | `tick` | tick scope that exited 1 | `ticks of …`, under no repository | no |
 *
 * Each row holds the failures in a row, the first and the last failure's
 * time, the last reason (one plain sentence, never a stack:
 * [ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)) and when the
 * action is next tried. A wake-up's tick row is quiet once a tick that read
 * its repository succeeded after its last failure: it keeps its count, but
 * nothing escalates it until a wake-up of that repository fails again.
 * A first failure is tried again at the next tick, as every action always
 * was; a second in a row moves the next try
 * `failures.backoff` after it, doubling with each failure after that up to
 * `failures.backoff_max`. A success removes the row, and so does the action
 * leaving the plan: each kind's planner, once it ran whole, names the keys
 * it still wants (`wanted`), and a row of that kind it did not name goes.
 *
 * Launch admission is outside it: a launch record counts its own attempts,
 * a pending record lost twice is stuck (`stuck-launches.ts`), and a refusal
 * that did not change is suppressed by its own record.
 */
import { stateRoot } from "../receipts.ts";
import { inTransaction, stateDb } from "./state.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";

/** What a row counts the failures of. */
export type FailureKind =
  | "label"
  | "notice"
  | "failure-notice"
  | "nudge"
  | "claim-end"
  | "marker-answer"
  | "repository"
  | "tick";

/** The kinds that are one action's: they back off. */
const ACTION_KINDS: ReadonlySet<FailureKind> = new Set([
  "label",
  "notice",
  "failure-notice",
  "nudge",
  "claim-end",
  "marker-answer",
]);

export function isActionKind(kind: FailureKind): boolean {
  return ACTION_KINDS.has(kind);
}

/** One row of the ledger. */
export interface FailureRow {
  /** The repository's `owner/name` for an action, its path for a repository's turn, `""` for the tick's. */
  repo: string;
  key: string;
  kind: FailureKind;
  /** What it is about, as the report names it: `PR #7`, the repository, the tick's scope. */
  target: string;
  /** Failures in a row. */
  count: number;
  firstAt: string;
  lastAt: string;
  /** The last failure, in one sentence. */
  reason: string;
  /** When the action is next tried; the last failure's time for a kind that does not back off. */
  nextAtMs: number;
  /** When a tick that read a wake-up row's repository succeeded after its last failure; `null` while none has. */
  quietAt: string | null;
  /** How many times a failure ended the row's quiet: each is a new notification's identity. */
  renewals: number;
}

/** The machine file's `failures` settings. */
export interface FailureSettings {
  /** `failures.backoff`: the wait after the second failure in a row, doubled with each one after it. */
  backoffMs: number;
  /** `failures.backoff_max`: the longest wait. */
  backoffMaxMs: number;
  /** `failures.notify_after`: the failures in a row at which a person is told. */
  notifyAfter: number;
  /** `failures.rerun_died`: the runs again a follow-up whose pass died or could not record its result is owed, `0` or `1`. */
  rerunDied: number;
}

/**
 * The defaults. A single failure waits for nothing, since most are a
 * passing error the next tick does not meet. Two minutes is one tick at the
 * interval a sweep is meant to run at, so a second failure costs one retry
 * at most; doubling reaches the hour after seven failures in a row, so an
 * action failing for a day is tried about thirty times rather than seven
 * hundred. Three in a row is past a passing outage (a forge's minute of
 * errors, one deploy) and, at a five-minute interval, within about a quarter
 * of an hour of a cause that stands.
 */
export const FAILURE_DEFAULTS: FailureSettings = {
  backoffMs: 2 * 60_000,
  backoffMaxMs: 60 * 60_000,
  notifyAfter: 3,
  rerunDied: 1,
};

/** The longest reason a row keeps. */
const MAX_REASON = 500;

/** How long after its `count`th failure in a row an action waits: nothing after the first. */
export function backoffAfter(count: number, settings: FailureSettings): number {
  if (count <= 1) return 0;
  const doubled = settings.backoffMs * 2 ** (count - 2);
  return Math.min(doubled, settings.backoffMaxMs);
}

/** A reason as a row keeps it: its first line, cut. */
function oneSentence(reason: string): string {
  const line = reason.split("\n")[0]?.trim() || "an unknown failure";
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

interface Stored {
  repo: string;
  key: string;
  kind: FailureKind;
  target: string;
  count: number;
  first_at: string;
  last_at: string;
  reason: string;
  next_at_ms: number;
  quiet_at: string | null;
  renewals: number;
}

/**
 * A failure written by a copy that predates the quiet columns moves
 * `last_at` and leaves `quiet_at` where it was, so a quiet that `last_at` has
 * passed is over, and counts as one renewal.
 */
function fromStored(r: Stored): FailureRow {
  const ended = r.quiet_at !== null && r.quiet_at < r.last_at;
  return {
    repo: r.repo,
    key: r.key,
    kind: r.kind,
    target: r.target,
    count: r.count,
    firstAt: r.first_at,
    lastAt: r.last_at,
    reason: r.reason,
    nextAtMs: r.next_at_ms,
    quietAt: ended ? null : r.quiet_at,
    renewals: r.renewals + (ended ? 1 : 0),
  };
}

const COLUMNS =
  "repo, key, kind, target, count, first_at, last_at, reason, next_at_ms, quiet_at, renewals";

/** Every row, or those of one repository. */
export function readFailures(repo?: string, root = stateRoot()): FailureRow[] {
  const db = stateDb(root);
  const rows = (
    repo === undefined
      ? db.query(`SELECT ${COLUMNS} FROM failures ORDER BY repo, key`).all()
      : db
          .query(`SELECT ${COLUMNS} FROM failures WHERE repo = ? ORDER BY key`)
          .all(repo)
  ) as Stored[];
  return rows.map(fromStored);
}

/** What one failure is about. */
export interface FailureOf {
  repo: string;
  key: string;
  kind: FailureKind;
  target: string;
}

/** The failures in a row after one more: as many as `notify_after` at least for one told at once. */
function countAfter(
  before: number,
  settings: FailureSettings,
  atOnce: boolean,
): number {
  return atOnce ? Math.max(before + 1, settings.notifyAfter) : before + 1;
}

/**
 * Count one more failure in a row; the row as it now reads. A failure a
 * person is told of at once (`atOnce`: a refused credential) counts as many
 * as `notify_after`.
 */
export function recordFailure(
  of: FailureOf,
  reason: string,
  nowMs: number,
  settings: FailureSettings,
  root = stateRoot(),
  atOnce = false,
): FailureRow {
  const db = stateDb(root);
  const at = isoFromMs(nowMs);
  const said = oneSentence(reason);
  return inTransaction(db, () => {
    const before = db
      .query(`SELECT ${COLUMNS} FROM failures WHERE repo = ? AND key = ?`)
      .get(of.repo, of.key) as Stored | null;
    const prior = before ? fromStored(before) : null;
    const count = countAfter(before?.count ?? 0, settings, atOnce);
    const next = isActionKind(of.kind)
      ? nowMs + backoffAfter(count, settings)
      : nowMs;
    const row: FailureRow = {
      ...of,
      count,
      firstAt: before?.first_at ?? at,
      lastAt: at,
      reason: said,
      nextAtMs: next,
      quietAt: null,
      renewals: prior ? prior.renewals + (prior.quietAt === null ? 0 : 1) : 0,
    };
    db.query(
      `INSERT INTO failures (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, key) DO UPDATE SET kind = excluded.kind,
         target = excluded.target, count = excluded.count,
         last_at = excluded.last_at, reason = excluded.reason,
         next_at_ms = excluded.next_at_ms, quiet_at = excluded.quiet_at,
         renewals = excluded.renewals`,
    ).run(
      row.repo,
      row.key,
      row.kind,
      row.target,
      row.count,
      row.firstAt,
      row.lastAt,
      row.reason,
      row.nextAtMs,
      row.quietAt,
      row.renewals,
    );
    return row;
  });
}

/** Its action succeeded: the row goes. */
export function clearFailure(
  repo: string,
  key: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query("DELETE FROM failures WHERE repo = ? AND key = ?")
    .run(repo, key);
}

/**
 * A tick that read the row's repository succeeded at `at`: the row keeps
 * its count and goes quiet until its next failure. Nothing when no row
 * stands under the key. A quiet that a later failure from a copy predating
 * the quiet columns already ended is counted as its renewal here, so the
 * renewal outlives the new quiet that replaces it (`fromStored`).
 */
export function quietFailure(
  repo: string,
  key: string,
  at: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `UPDATE failures SET quiet_at = ?,
         renewals = renewals + (quiet_at IS NOT NULL AND quiet_at < last_at)
       WHERE repo = ? AND key = ?`,
    )
    .run(at, repo, key);
}

/** Whether a row is past the threshold and not quiet: what a person is told. */
export function escalates(row: FailureRow, settings: FailureSettings): boolean {
  return row.count >= settings.notifyAfter && row.quietAt === null;
}

/**
 * The rows of `kind` under `repo` whose key is not in `wanted` go: their
 * action left the plan. A row whose target `unobserved` names stays: its
 * action's absence from the plan proves nothing while its target was not
 * observed.
 */
function dropUnwanted(
  repo: string,
  kind: FailureKind,
  wanted: ReadonlySet<string>,
  unobserved: ((target: string) => boolean) | undefined,
  root = stateRoot(),
): void {
  const db = stateDb(root);
  const rows = db
    .query("SELECT key, target FROM failures WHERE repo = ? AND kind = ?")
    .all(repo, kind) as Array<{ key: string; target: string }>;
  const gone = rows.filter(
    (r) => !wanted.has(r.key) && unobserved?.(r.target) !== true,
  );
  if (gone.length === 0) return;
  const drop = db.query("DELETE FROM failures WHERE repo = ? AND key = ?");
  inTransaction(db, () => {
    for (const r of gone) drop.run(repo, r.key);
  });
}

/** The receipt's line for a row. */
export interface FailureEntry {
  kind: FailureKind;
  repo: string;
  key: string;
  target: string;
  count: number;
  since: string;
  last: string;
  /** For an action backing off: when it is next tried. */
  nextTry?: string;
}

export function entryOf(row: FailureRow): FailureEntry {
  return {
    kind: row.kind,
    repo: row.repo,
    key: row.key,
    target: row.target,
    count: row.count,
    since: row.firstAt,
    last: row.reason,
    ...(isActionKind(row.kind) ? { nextTry: isoFromMs(row.nextAtMs) } : {}),
  };
}

/** Why an action whose row is `row` is not tried now; `null` when it is due. */
function backingOff(row: FailureRow, nowMs: number): string | null {
  if (!isActionKind(row.kind) || row.nextAtMs <= nowMs) return null;
  return `backing off after ${row.count} failure${row.count === 1 ? "" : "s"} in a row since ${row.firstAt} (the last: ${row.reason}); next try at ${isoFromMs(row.nextAtMs)}`;
}

/**
 * One repository's actions as a turn tries them: whether each is due, what
 * each attempt did, and which keys each kind's planner still wants. A write
 * the database refuses is reported (`onWriteFailed`) and leaves the action
 * as it is: the ledger only paces and escalates, it never stops an action.
 */
export interface ActionBook {
  /** Why the action under `key` backs off now; `null` when it is due. */
  waits(key: string): string | null;
  /** Whether a row stands under `key`: not cleared by a success or by its action leaving the plan this tick. */
  standing(key: string): boolean;
  /** An attempt: `failure` its reason, `null` a success. */
  ran(of: Omit<FailureOf, "repo">, failure: string | null): void;
  /**
   * The planner of `kind` ran whole and wants these keys: the others' rows
   * go, except those whose target `unobserved` names (not observed this
   * tick, so its action's absence is no evidence it left the plan).
   */
  wanted(
    kind: FailureKind,
    keys: Iterable<string>,
    unobserved?: (target: string) => boolean,
  ): void;
}

export function actionBook(
  repo: string,
  settings: FailureSettings,
  onWriteFailed: (reason: string) => void,
  root = stateRoot(),
): ActionBook {
  const rows = new Map<string, FailureRow>();
  const write = (run: () => void) => {
    try {
      run();
    } catch (error) {
      onWriteFailed(
        `the failure ledger was not written: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
  };
  write(() => {
    for (const row of readFailures(repo, root)) rows.set(row.key, row);
  });
  return {
    standing: (key) => rows.has(key),
    waits: (key) => {
      const row = rows.get(key);
      return row === undefined ? null : backingOff(row, currentMs());
    },
    ran: (of, failure) =>
      write(() => {
        if (failure === null) {
          if (!rows.has(of.key)) return;
          clearFailure(repo, of.key, root);
          rows.delete(of.key);
          return;
        }
        rows.set(
          of.key,
          recordFailure({ ...of, repo }, failure, currentMs(), settings, root),
        );
      }),
    wanted: (kind, keys, unobserved) =>
      write(() => {
        const keep = new Set(keys);
        dropUnwanted(repo, kind, keep, unobserved, root);
        for (const [key, row] of rows)
          if (
            row.kind === kind &&
            !keep.has(key) &&
            unobserved?.(row.target) !== true
          )
            rows.delete(key);
      }),
  };
}
