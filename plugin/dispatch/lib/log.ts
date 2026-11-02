/**
 * The outcome log, the state database's `log` table (`state.ts`): one row
 * per launch record that ended and per cause the tick observed, which
 * nothing removes. Receipts and launch records are working records and
 * expire with the machine file's retention; the log is what the factory
 * learns from, read by people, by `jig dispatch dashboard` and by
 * `jig dispatch log`, and never planned from.
 *
 * Two kinds of row, each with its key and its time:
 *
 * - **ended**: one per launch record, when the record ends, timed at its
 *   end: the stage, the repository, the item or pull request, the account,
 *   the model, the duration, a drive's rounds, an outcome class from the
 *   closed list (`OUTCOME_CLASSES`) and a reason that carries the stage's
 *   own answer verbatim (the exit, the recorded result, or the last state);
 * - **event**: once per cause, timed when the tick observed it, for what
 *   the tick observed rather than what ended (a stalled pickup, a double
 *   claim, a stage drifting from its expectation, a session waiting, a stop
 *   it notified on a stage it did not launch, each nudge sent, and a pull
 *   request's hold behind another in a serialized area beginning and
 *   ending, the end carrying how long it waited: `serial-holds.ts`).
 *
 * A row's key is unique in the table, and a row is written in the same
 * transaction as what it records (a record's end, a suppression record, a
 * nudge's delivery mark): the two land together or not at all, so a tick
 * that stops between them leaves nothing for the next one to repair. Each
 * row is kept as the JSON line the text copy (`log-export.ts`) and
 * `jig dispatch log --jsonl` print, beside the columns the dashboard
 * filters on.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import {
  isDrive,
  type LaunchAction,
  type ReadRecord,
  targetOf,
} from "./launches.ts";
import { existingStateDb, stateDb } from "./state.ts";

/**
 * The closed list of outcome classes. An answer that fits more than one
 * takes the first in this order; one that fits none is `unknown`, carrying
 * its last state, so the list grows from the log, never from guesses.
 */
export const OUTCOME_CLASSES = [
  "converged",
  "merged",
  "quota wall",
  "parked for a person",
  "stalled",
  "died",
  "refused",
  "gates failed",
  "double claim",
  "unknown",
] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** One launch record's end. */
export interface EndedRow {
  kind: "ended";
  key: string;
  at: string;
  repo: string;
  stage: LaunchAction;
  target: string;
  record: string;
  account: string;
  /** The model the tick launched it with; `null` when it named none. */
  model: string | null;
  durationMs: number | null;
  /** A drive's rounds: its ledger's round at the end less the round at launch; `null` for any other stage, or when either is unknown. */
  rounds: number | null;
  class: OutcomeClass;
  reason: string;
}

/** One cause the tick observed. */
export interface EventRow {
  kind: "event";
  key: string;
  at: string;
  repo: string;
  /** The stage the cause is about: a drive's `rearm`, a `pickup`, a `followup`, a nudge's `steer`. */
  stage: string;
  target: string;
  /** What was observed: the notification's cause, or `nudge`. */
  event: string;
  account: string | null;
  /** The class the closed list places it in; `null` for an observation no class names (a drift, a wait, a nudge, a hold). */
  class: OutcomeClass | null;
  reason: string;
  /** For the end of a hold: how long the pull request waited. */
  durationMs?: number;
}

export type LogRow = EndedRow | EventRow;

/** The month's text copy a time falls in (`log-export.ts`). */
export function logFile(at: string, root = stateRoot()): string {
  return join(root, `log-${monthOf(at)}.jsonl`);
}

/** A time's month, `<year>-<month>` in UTC. */
export function monthOf(at: string): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isClass(value: unknown): value is OutcomeClass {
  return (OUTCOME_CLASSES as readonly unknown[]).includes(value);
}

/** The text fields every row carries. */
const ROW_TEXT = ["key", "at", "repo", "stage", "target", "reason"] as const;

/** Whether the kind-specific fields of a row read. */
function kindReads(value: Record<string, unknown>): boolean {
  if (value.kind === "ended")
    return isClass(value.class) && typeof value.account === "string";
  return (
    value.kind === "event" &&
    typeof value.event === "string" &&
    (value.class === null || isClass(value.class))
  );
}

/** Whether a parsed line is a row this reader knows. */
function isRow(value: unknown): value is LogRow {
  return (
    isMapping(value) &&
    ROW_TEXT.every((k) => typeof value[k] === "string") &&
    Number.isFinite(Date.parse(value.at as string)) &&
    kindReads(value)
  );
}

/** A line of the text copy as a row; `null` for a line that is not one. */
export function parseLine(line: string): LogRow | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRow(value) ? value : null;
  } catch (error) {
    swallow(error, "a line of the outcome log that is not a row is skipped");
    return null;
  }
}

/** The class a row counts under: its class, else (an observation no class names) its event. */
export function bucket(row: LogRow): string {
  if (row.class !== null) return row.class;
  return row.kind === "event" ? `event: ${row.event}` : "unknown";
}

/**
 * Write `row` into the log, unless a row with its key is already there:
 * true when this call wrote it. Called inside the transaction that writes
 * what the row records, it lands with it or not at all.
 */
export function insertRow(db: Database, row: LogRow): boolean {
  const done = db
    .query(
      `INSERT INTO log (key, kind, at, at_ms, repo, stage, account, bucket, reason, row)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
    )
    .run(
      row.key,
      row.kind,
      row.at,
      Date.parse(row.at),
      row.repo,
      row.stage,
      row.account,
      bucket(row),
      row.reason,
      JSON.stringify(row),
    );
  return done.changes === 1;
}

/** Write `row` on its own: true when this call wrote it. */
export function writeRow(row: LogRow, root = stateRoot()): boolean {
  return insertRow(stateDb(root), row);
}

/** Every row timed within `[fromMs, toMs]`, in the order they were written; none before the database exists. */
export function readRows(
  fromMs = Number.NEGATIVE_INFINITY,
  toMs = Number.POSITIVE_INFINITY,
  root = stateRoot(),
): LogRow[] {
  const db = existingStateDb(root);
  if (db === null) return [];
  const rows = db
    .query("SELECT row FROM log WHERE at_ms >= ? AND at_ms <= ? ORDER BY seq")
    .all(
      Number.isFinite(fromMs) ? fromMs : Number.MIN_SAFE_INTEGER,
      Number.isFinite(toMs) ? toMs : Number.MAX_SAFE_INTEGER,
    ) as Array<{ row: string }>;
  return rowsOf(rows);
}

/** The rows a query over the log table selected, as rows; one whose text does not read as a row is left out. */
export function rowsOf(selected: Array<{ row: string }>): LogRow[] {
  return selected
    .map((r) => parseLine(r.row))
    .filter((r): r is LogRow => r !== null);
}

/** `drive.ts`'s exits, by the class the closed list places them in (all but `5`, which reads the pull request). */
const DRIVE_EXITS: ReadonlyMap<number, [OutcomeClass, string]> = new Map([
  [0, ["converged", "converged"]],
  [16, ["quota wall", "quota-parked"]],
  [8, ["parked for a person", "parked"]],
  [14, ["stalled", "stalled"]],
  [6, ["stalled", "round limit"]],
  [2, ["refused", "usage"]],
  [4, ["refused", "not judgeable yet"]],
  [11, ["refused", "another driver holds it"]],
  [13, ["refused", "another driver holds it"]],
  [18, ["refused", "a mailbox stop"]],
  [19, ["refused", "a mailbox pause"]],
  [20, ["refused", "taken over by another clone"]],
  [1, ["gates failed", "failed"]],
  [7, ["gates failed", "exit 7"]],
  [9, ["gates failed", "exit 9"]],
  [12, ["gates failed", "exit 12"]],
  [15, ["gates failed", "exit 15"]],
]);

/** What the classifier needs beyond the record: whether a takeover replaced it, and a merged-or-closed drive's pull request state. */
export interface EndFacts {
  takenOver: boolean;
  /** For a drive that stopped `5`: true when its pull request merged, false when it was closed, `null` when that could not be read. */
  merged: boolean | null;
}

/** The class of a drive's exit, as the closed list places it (`5` reads as closed when `merged` is false). */
export function driveClass(
  code: number,
  merged: boolean | null,
): { class: OutcomeClass; reason: string } {
  if (code === 5) {
    if (merged === true) return { class: "merged", reason: "exit 5 (merged)" };
    if (merged === false)
      return { class: "refused", reason: "exit 5 (closed)" };
    return {
      class: "unknown",
      reason:
        "exit 5, and whether the pull request merged or closed could not be read",
    };
  }
  const placed = DRIVE_EXITS.get(code);
  return placed === undefined
    ? { class: "unknown", reason: `exit ${code}` }
    : { class: placed[0], reason: `exit ${code} (${placed[1]})` };
}

/** The wall an interactive session still waited on when it ended, if any. */
function wallAtEnd(r: ReadRecord, endedAt: string): string | null {
  const latest = r.record.episodes?.at(-1);
  if (latest === undefined || !latest.last) return null;
  const stood =
    latest.resetAt === null || Date.parse(latest.resetAt) > Date.parse(endedAt);
  return stood
    ? `waiting on a usage-limit wall since ${latest.observedAt} (resets ${latest.resetAt ?? "at an unknown time"}): ${latest.evidence}`
    : null;
}

/** An interactive session's class: its recorded result, else how it ended. */
function sessionClass(
  r: ReadRecord,
  endedAt: string,
): { class: OutcomeClass; reason: string } {
  if (r.result === "done") return { class: "converged", reason: "result done" };
  if (r.result === "failed")
    return { class: "gates failed", reason: "result failed" };
  const s = r.state;
  const how =
    s.kind === "ended"
      ? s.agent === undefined
        ? `its session exited ${s.exit.code ?? s.exit.signal ?? "without a code"}`
        : `its agent finished ${s.agent}`
      : "its wrapper is gone without an exit";
  const wall = wallAtEnd(r, endedAt);
  return wall === null
    ? { class: "died", reason: `no result recorded; ${how}` }
    : { class: "quota wall", reason: `no result recorded; ${how}; ${wall}` };
}

/** The class and reason of a record that ended, first match in table order. */
export function classifyEnded(
  r: ReadRecord,
  endedAt: string,
  facts: EndFacts,
): { class: OutcomeClass; reason: string } {
  const s = r.state;
  if (isDrive(r.record)) {
    const answer =
      s.kind === "ended"
        ? s.exit.code === null
          ? `signal ${s.exit.signal ?? "unknown"}`
          : `exit ${s.exit.code}`
        : "its wrapper is gone without an exit";
    if (facts.takenOver)
      return { class: "stalled", reason: `taken over (${answer})` };
    if (s.kind === "ended" && s.exit.code !== null)
      return driveClass(s.exit.code, facts.merged);
    return { class: "died", reason: answer };
  }
  return sessionClass(r, endedAt);
}

/** Whether a record has ended, as the log counts an end: an exit, or a process gone without one. */
export function hasEnded(r: ReadRecord): boolean {
  return r.state.kind === "ended" || r.state.kind === "died";
}

/** When a record ended: its exit's time, else (a process gone without one) `observedAt`. */
export function endTime(r: ReadRecord, observedAt: string): string {
  return r.state.kind === "ended" ? r.state.exit.at : observedAt;
}

/** The ended row of a record that ended at `endedAt`. */
export function endedRow(
  r: ReadRecord,
  endedAt: string,
  facts: EndFacts,
  endRound: number | null,
): EndedRow {
  const { record } = r;
  const placed = classifyEnded(r, endedAt, facts);
  // A re-drive ends like any re-arm; its reason also names why the drive was stale.
  const reason =
    record.redrive == null
      ? placed.reason
      : `${placed.reason}; re-drive of a stale converged pull request: ${record.redrive.cause}`;
  const duration = Date.parse(endedAt) - Date.parse(record.createdAt);
  const start = record.round ?? null;
  return {
    kind: "ended",
    key: `ended ${record.id}`,
    at: endedAt,
    repo: record.repo,
    stage: record.action,
    target: targetOf(record),
    record: record.id,
    account: record.account,
    model: record.model,
    durationMs: Number.isFinite(duration) ? Math.max(0, duration) : null,
    rounds:
      isDrive(record) && start !== null && endRound !== null
        ? Math.max(0, endRound - start)
        : null,
    class: placed.class,
    reason,
  };
}
