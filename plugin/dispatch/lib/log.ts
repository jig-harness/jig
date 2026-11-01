/**
 * The outcome log, under `~/.local/state/jig/dispatch/`: one file per month
 * (`log-<year>-<month>.jsonl`), one row per line, which nothing removes.
 * Receipts and launch records are working records and expire with the
 * machine file's retention; the log is what the factory learns from, read
 * by people and by `jig dispatch dashboard`, and never planned from.
 *
 * Two kinds of row, each with its key and its time, in the file of the
 * month its time falls in:
 *
 * - **ended**: one per launch record, when the record ends, timed at its
 *   end: the stage, the repository, the item or pull request, the account,
 *   the model, the duration, a drive's rounds, an outcome class from the
 *   closed list (`OUTCOME_CLASSES`) and a reason that carries the stage's
 *   own answer verbatim (the exit, the recorded result, or the last state);
 * - **event**: once per cause, timed when the tick observed it, for what
 *   the tick observed rather than what ended (a stalled pickup, a double
 *   claim, a stage drifting from its expectation, a session waiting, a stop
 *   it notified on a stage it did not launch, each nudge sent).
 *
 * A row is one line written in one append. Before it appends, the writer
 * settles an unterminated last line (one that parses keeps it and gains its
 * newline, one that does not is cut off), and looks for the row's key among
 * the file's last rows, so a retry after a tick that stopped between the
 * append and its mark writes nothing twice. A reader skips any line that
 * does not parse as a row.
 */
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
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
  /** The class the closed list places it in; `null` for an observation no class names (a drift, a wait, a nudge). */
  class: OutcomeClass | null;
  reason: string;
}

export type LogRow = EndedRow | EventRow;

const FILE = /^log-(\d{4})-(\d{2})\.jsonl$/;

/** The month file a time falls in. */
export function logFile(at: string, root = stateRoot()): string {
  const d = new Date(at);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(root, `log-${d.getUTCFullYear()}-${month}.jsonl`);
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

function parseLine(line: string): LogRow | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRow(value) ? value : null;
  } catch (error) {
    // A torn or foreign line is not a row; readers skip it.
    swallow(error, "a line of the outcome log that is not a row is skipped");
    return null;
  }
}

/** The longest unterminated last line kept when it parses; a longer one is cut off. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** The offset just after the file's last newline before `size`; 0 when it has none. */
function lineStart(fd: number, size: number): number {
  const chunk = Buffer.alloc(64 * 1024);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const read = readSync(fd, chunk, 0, end - start, start);
    const at = chunk.subarray(0, read).lastIndexOf(0x0a);
    if (at !== -1) return start + at + 1;
    end = start;
  }
  return 0;
}

/**
 * Settle an unterminated last line: one that parses keeps it and gains its
 * newline, one that does not is cut off whole. Returns the file's size after.
 */
function settleLastLine(fd: number, size: number): number {
  if (size === 0) return 0;
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  if (last.toString() === "\n") return size;
  const start = lineStart(fd, size);
  if (size - start <= MAX_LINE_BYTES) {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    if (parseLine(buffer.toString("utf8")) !== null) {
      writeSync(fd, "\n", size);
      return size + 1;
    }
  }
  ftruncateSync(fd, start);
  return start;
}

/** Whether a month file already holds a row with `key`. */
function holdsKey(path: string, key: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    swallow(error, `${path} does not read`);
    return false;
  }
  const needle = `"key":${JSON.stringify(key)}`;
  return text
    .split("\n")
    .some((line) => line.includes(needle) && parseLine(line)?.key === key);
}

/**
 * Append `row` to its month's file, unless a row with its key is already in
 * the file: true when this call wrote it.
 */
export function appendRow(row: LogRow, root = stateRoot()): boolean {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = logFile(row.at, root);
  const fd = openSync(path, "a+", 0o600);
  try {
    const size = settleLastLine(fd, statSync(path).size);
    if (holdsKey(path, row.key)) return false;
    writeSync(fd, `${JSON.stringify(row)}\n`, size);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** The month files whose month overlaps `[fromMs, toMs]`, oldest first. */
function monthFiles(root: string, fromMs: number, toMs: number): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    swallow(error, "no outcome log yet");
    return [];
  }
  return names
    .filter((name) => {
      const m = FILE.exec(name);
      if (m === null) return false;
      const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
      const end = Date.UTC(Number(m[1]), Number(m[2]), 1);
      return end > fromMs && start <= toMs;
    })
    .sort()
    .map((name) => join(root, name));
}

/** Every row timed within `[fromMs, toMs]`, in file order; a line that does not parse is skipped. */
export function readRows(
  fromMs = Number.NEGATIVE_INFINITY,
  toMs = Number.POSITIVE_INFINITY,
  root = stateRoot(),
): LogRow[] {
  const rows: LogRow[] = [];
  for (const path of monthFiles(root, fromMs, toMs)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      swallow(error, `${path} does not read`);
      continue;
    }
    for (const line of text.split("\n")) {
      const row = parseLine(line);
      if (row === null) continue;
      const at = Date.parse(row.at);
      if (at >= fromMs && at <= toMs) rows.push(row);
    }
  }
  return rows;
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
    reason: placed.reason,
  };
}
