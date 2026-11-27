/**
 * The rows behind a recurring class (`recurring.ts`), one occurrence each:
 * when it was, the pull request or item it was about, the head commit where
 * a launch record still names it, and the last word the run left (its
 * reason, and what its closing report concluded).
 *
 * A drive's stall is settled by its own next step: the dispatcher re-drives
 * it once per head commit. A stall the next drive launched for its pull
 * request re-drove is that re-drive's to settle, so it carries the re-drive
 * (`redrive`) and is not counted toward a recurrence; a stall the re-drive
 * did not follow (a re-drive that stalled again on its head, a stall with
 * no head to key a re-drive on, a round limit or a takeover) is. A stall
 * whose launch records have expired cannot be told handled, and counts.
 */
import type { Database } from "bun:sqlite";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { parseMs } from "../../shared/time.ts";
import type { RecurringClass } from "./dashboard-contract.ts";
import { prHeadOf } from "./failed-rearms.ts";
import { OUTCOME_CLASSES, type OutcomeClass } from "./log.ts";

/** The classes that are not a stage finishing badly: the finished-well ones, a park, which is a person's to answer, and a follow-up waiting on an arm still pending. */
const NOT_BAD: readonly OutcomeClass[] = [
  "converged",
  "merged",
  "parked for a person",
  "arm pending",
];

const quoted = (names: readonly string[]) =>
  names.map((name) => `'${name.replaceAll("'", "''")}'`).join(", ");

/**
 * The rows a recurrence counts, in SQL over the log table: an ended row of a
 * bad class, or an event row whose bucket is a class (an event row that
 * carries none is bucketed under its event).
 */
export const COUNTED = `bucket NOT IN (${quoted(NOT_BAD)})
  AND (kind = 'ended' OR bucket IN (${quoted(OUTCOME_CLASSES)}))`;

/** The stages a drive's rows are logged under. */
const DRIVE_STAGES: readonly string[] = ["rearm", "takeover"];

/** Whether a class's stalls are the once-per-head re-drive's to settle: a drive's stall. */
export function settlesByRedrive(
  r: Pick<RecurringClass, "class" | "stage">,
): boolean {
  return r.class === "stalled" && DRIVE_STAGES.includes(r.stage);
}

/** One row a recurring class counted, or one the re-drive settled. */
export interface Occurrence {
  atMs: number;
  at: string;
  /** The pull request or item, as the log names it (`PR #12`). */
  target: string;
  /** The head commit, where a launch record names it; `null` where none does. */
  head: string | null;
  /** The reason the row gives: the stage's own answer. */
  reason: string;
  /** What the run's closing report concluded, cut short; `null` when it left none. */
  concluded: string | null;
  /** For a stall the next drive re-drove: that re-drive's record id; `null` otherwise. */
  redrive: string | null;
}

/** The parts of a launch record this module reads. */
interface Launch {
  id: string;
  action: string;
  createdMs: number;
  /** The change a re-drive re-drove (`head <sha>, stopped <exit>`), and of which stop. */
  redrive: { change: string; mechanicalStop: string | null } | null;
  heads: string | null;
}

function launchOf(text: string): Launch | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    swallow(error, "a launch record does not read");
    return null;
  }
  if (!isMapping(value) || typeof value.id !== "string") return null;
  const createdMs = parseMs(String(value.createdAt));
  if (!Number.isFinite(createdMs)) return null;
  const redrive = isMapping(value.redrive) ? value.redrive : null;
  return {
    id: value.id,
    action: String(value.action),
    createdMs,
    redrive:
      redrive !== null && typeof redrive.change === "string"
        ? {
            change: redrive.change,
            mechanicalStop:
              typeof redrive.mechanicalStop === "string"
                ? redrive.mechanicalStop
                : null,
          }
        : null,
    heads: typeof value.heads === "string" ? value.heads : null,
  };
}

/** A pull request's drive launches, oldest first, as the launches table keeps them. */
function drivesOfPr(db: Database, repo: string, pr: number): Launch[] {
  const rows = db
    .query(
      `SELECT record FROM launches WHERE repo = ? AND pr = ?
         AND action IN (${quoted(DRIVE_STAGES)})`,
    )
    .all(repo, pr) as Array<{ record: string }>;
  return rows
    .map((r) => launchOf(r.record))
    .filter((l): l is Launch => l !== null)
    .sort((a, b) => a.createdMs - b.createdMs);
}

const SHORT = 7;
const headOfChange = (change: string | undefined) =>
  /^head ([0-9a-f]{7,40})\b/.exec(change ?? "")?.[1] ?? null;
const short = (sha: string | null) =>
  sha === null ? null : sha.slice(0, SHORT);

/** The row's text, as `log.ts` keeps it, for its record and closing report. */
interface RowText {
  record?: unknown;
  concluded?: unknown;
}

function rowText(text: string): RowText {
  try {
    const value: unknown = JSON.parse(text);
    return isMapping(value) ? value : {};
  } catch (error) {
    swallow(error, "a log row does not read");
    return {};
  }
}

const CONCLUDED_CHARS = 160;

function concludedOf(concluded: unknown): string | null {
  if (typeof concluded !== "string" || concluded.trim() === "") return null;
  const text = concluded.trim().replace(/\s+/g, " ");
  return text.length > CONCLUDED_CHARS
    ? `${text.slice(0, CONCLUDED_CHARS - 1)}…`
    : text;
}

/**
 * Where a drive's row stands against the re-drive: the head it names, and
 * the re-drive that followed it when the next drive launched for its pull
 * request after the row re-drove a stall.
 */
function againstRedrive(
  launches: readonly Launch[],
  record: unknown,
  atMs: number,
): Pick<Occurrence, "head" | "redrive"> {
  const own = launches.find((l) => l.id === record);
  const next = launches.find((l) => l.createdMs > atMs);
  const redrove = next?.redrive?.mechanicalStop === "stall" ? next : undefined;
  const head =
    headOfChange(redrove?.redrive?.change) ??
    headOfChange(own?.redrive?.change) ??
    prHeadOf(own?.heads);
  return { head: short(head), redrive: redrove?.id ?? null };
}

const PR_TARGET = /^PR #(\d+)$/;

/**
 * Every row of `r` within `[fromMs, toMs]` that a recurrence would count,
 * oldest first; a drive's stall the re-drive followed carries it in
 * `redrive`.
 */
export function occurrences(
  db: Database,
  r: Pick<RecurringClass, "class" | "repo" | "stage">,
  fromMs: number,
  toMs: number,
): Occurrence[] {
  const rows = db
    .query(
      `SELECT at, at_ms, reason, row, json_extract(row, '$.target') AS target FROM log
       WHERE at_ms >= ? AND at_ms <= ? AND repo = ? AND stage = ? AND bucket = ?
         AND ${COUNTED}
       ORDER BY at_ms, seq`,
    )
    .all(fromMs, toMs, r.repo, r.stage, r.class) as Array<{
    at: string;
    at_ms: number;
    reason: string;
    row: string;
    target: string | null;
  }>;
  const drives = new Map<number, Launch[]>();
  const launchesOf = (pr: number) => {
    const known = drives.get(pr);
    if (known !== undefined) return known;
    const read = drivesOfPr(db, r.repo, pr);
    drives.set(pr, read);
    return read;
  };
  return rows.map((row) => {
    const text = rowText(row.row);
    const target = row.target ?? "";
    const pr = DRIVE_STAGES.includes(r.stage)
      ? PR_TARGET.exec(target)?.[1]
      : undefined;
    const placed =
      pr === undefined
        ? { head: null, redrive: null }
        : againstRedrive(launchesOf(Number(pr)), text.record, row.at_ms);
    return {
      atMs: row.at_ms,
      at: row.at,
      target,
      head: placed.head,
      redrive: settlesByRedrive(r) ? placed.redrive : null,
      reason: row.reason,
      concluded: concludedOf(text.concluded),
    };
  });
}

/** The reasons the occurrences give most often, with how many give each, the most first. */
export function topReasons(
  counted: readonly Occurrence[],
  limit = 3,
): Array<{ reason: string; rows: number }> {
  const counts = new Map<string, number>();
  for (const o of counted)
    counts.set(o.reason, (counts.get(o.reason) ?? 0) + 1);
  return [...counts]
    .map(([reason, rows]) => ({ reason, rows }))
    .sort((a, b) => b.rows - a.rows || (a.reason < b.reason ? -1 : 1))
    .slice(0, limit);
}
