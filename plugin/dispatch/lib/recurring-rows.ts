/**
 * The rows behind a recurring class (`recurring.ts`), one occurrence each:
 * when it was, the pull request or item it was about, the head commit where
 * a launch record still names it, and the last word the run left (its
 * reason, and what its closing report concluded).
 *
 * A drive's stall is settled by its own next step: the dispatcher re-drives
 * it once per head commit. A stall the next drive launched for its pull
 * request re-drove is that re-drive's to settle, so it carries the re-drive
 * (`redrive`) and is not counted toward a recurrence. That needs an intact,
 * immediately succeeding launch record: a missing or unreadable record makes
 * the relationship uncertain, and the stall counts. A stall the re-drive did
 * not follow (a re-drive that stalled again on its head, a stall with no head
 * to key a re-drive on, a round limit or a takeover) is likewise counted.
 * The head a row names comes from the launch records too: the change the
 * re-drive that followed it re-drove, else the one its own launch re-drove,
 * else the head its launch recorded.
 */
import type { Database } from "bun:sqlite";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { parseMs } from "../../shared/time.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
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
  createdMs: number;
  /** For a re-drive: the change it re-drove (`head <sha>, stopped <exit>`); `null` for any other launch. */
  change: string | null;
  /** Whether it re-drove a stall. */
  redroveStall: boolean;
  heads: string | null;
}

/** A launch-table row, including one whose record cannot establish succession. */
interface LaunchRow {
  /** Stable launch-record key. It identifies a row but does not order a time tie. */
  id: string;
  launch: Launch | null;
  createdMs: number | null;
}

const textOf = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isMapping(value) ? value : null;
  } catch (error) {
    swallow(error, "a stored row does not read");
    return null;
  }
}

function launchOf(text: string): Launch | null {
  const value = parsed(text);
  const id = textOf(value?.id);
  const createdMs = parseMs(textOf(value?.createdAt) ?? "");
  if (value === null || id === null || !Number.isFinite(createdMs)) return null;
  const redrive = isMapping(value.redrive) ? value.redrive : {};
  return {
    id,
    createdMs,
    change: textOf(redrive.change),
    redroveStall: redrive.mechanicalStop === "stall",
    heads: textOf(value.heads),
  };
}

/** A pull request's drive launches, oldest first, retaining unreadable records as uncertainty. */
function drivesOfPr(db: Database, repo: string, pr: number): LaunchRow[] {
  const rows = db
    .query(
      `SELECT id, record, created_at FROM launches WHERE repo = ? AND pr = ?
         AND action IN (${quoted(DRIVE_STAGES)}) ORDER BY created_at, id`,
    )
    .all(repo, pr) as Array<{ id: string; record: string; created_at: string }>;
  return rows
    .map((r) => ({
      id: r.id,
      launch: launchOf(r.record),
      createdMs: (() => {
        const createdMs = parseMs(r.created_at);
        return Number.isFinite(createdMs) ? createdMs : null;
      })(),
    }))
    .sort(
      (a, b) =>
        (a.createdMs ?? Infinity) - (b.createdMs ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
}

const SHORT = 7;
const headOfChange = (change: string | null | undefined) =>
  /^head ([0-9a-f]{7,40})\b/.exec(change ?? "")?.[1] ?? null;
const short = (sha: string | null) =>
  sha === null ? null : sha.slice(0, SHORT);

const CONCLUDED_CHARS = 160;

function concludedOf(concluded: unknown): string | null {
  if (typeof concluded !== "string" || concluded.trim() === "") return null;
  const text = concluded.trim().replace(/\s+/g, " ");
  return text.length > CONCLUDED_CHARS
    ? `${text.slice(0, CONCLUDED_CHARS - 1)}…`
    : text;
}

const PR_TARGET = /^PR #(\d+)$/;
/** A drive's stall as its ended row's reason gives it (`log.ts`): a round limit or a takeover is not one. */
const STALL_EXIT = new RegExp(`^exit ${DRIVE_EXIT.STALLED}\\b`);

/**
 * Where a drive's row stands against the re-drive: the head it names, and,
 * for a stall (`exit 14`), the re-drive that followed it when the next drive
 * launched for its pull request immediately after the row's own launch
 * re-drove a stall. The own launch and its successor must both be readable;
 * otherwise an intervening launch could make the relationship false.
 */
function againstRedrive(
  launches: readonly LaunchRow[],
  row: { record: unknown; atMs: number; reason: string },
): Pick<Occurrence, "head" | "redrive"> {
  const ownIndex = launches.findIndex((l) => l.launch?.id === row.record);
  if (ownIndex < 0) return { head: null, redrive: null };
  const own = launches[ownIndex]?.launch ?? null;
  // The table records only whole milliseconds. Both sides of the proposed
  // succession must therefore have unique, readable timestamps; a tie at
  // either side cannot establish which launch immediately followed another.
  // A tie elsewhere does not change this pair's order.
  const ordered = launches.every((launch) => launch.createdMs !== null);
  const successor = launches[ownIndex + 1] ?? null;
  const ownTimestampIsUnique =
    own !== null &&
    launches.filter((launch) => launch.createdMs === own.createdMs).length ===
      1;
  const successorTimestampIsUnique =
    successor !== null &&
    launches.filter((launch) => launch.createdMs === successor.createdMs)
      .length === 1;
  if (!ordered || !ownTimestampIsUnique || !successorTimestampIsUnique)
    return { head: short(headOf(null, own)), redrive: null };
  const next = successor?.launch ?? null;
  const redrove =
    next?.redroveStall === true && STALL_EXIT.test(row.reason) ? next : null;
  return { head: short(headOf(redrove, own)), redrive: redrove?.id ?? null };
}

/** The head a stall stopped at: the change its re-drive re-drove, else the one it re-drove itself, else the head it launched at. */
function headOf(redrove: Launch | null, own: Launch | null): string | null {
  const stopped = headOfChange(redrove?.change);
  if (stopped !== null) return stopped;
  return headOfChange(own?.change) ?? prHeadOf(own?.heads);
}

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
  const drives = new Map<number, LaunchRow[]>();
  const launchesOf = (pr: number) => {
    const known = drives.get(pr);
    if (known !== undefined) return known;
    const read = drivesOfPr(db, r.repo, pr);
    drives.set(pr, read);
    return read;
  };
  return rows.map((row) => {
    const text = parsed(row.row) ?? {};
    const target = row.target ?? "";
    const pr = DRIVE_STAGES.includes(r.stage)
      ? PR_TARGET.exec(target)?.[1]
      : undefined;
    const placed =
      pr === undefined
        ? { head: null, redrive: null }
        : againstRedrive(launchesOf(Number(pr)), {
            record: text.record,
            atMs: row.at_ms,
            reason: row.reason,
          });
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
