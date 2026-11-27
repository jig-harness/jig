/**
 * The one definition of a recurring class, which the dashboard lists
 * (`dashboard-log.ts`) and the reflection route records (`reflection-route.ts`):
 * a bad class (any but `converged`, `merged`, `parked for a person` and
 * `arm pending`) of one stage on one repository, on at least three of the
 * last seven host days,
 * today included. It counts the outcome log's ended rows and the event rows
 * that carry a class, such as a drive stopped for a person; an event row that
 * carries none (a drift, a wait, a nudge, a hold) stays out, however often it
 * occurs. A drive's stall the once-per-head re-drive followed is that
 * re-drive's to settle and is not counted (`recurring-rows.ts`).
 */
import type { Database } from "bun:sqlite";
import type { RecurringClass } from "./dashboard-contract.ts";
import { midnightIn } from "./host-time.ts";
import { COUNTED, occurrences, settlesByRedrive } from "./recurring-rows.ts";

/** The host days a class is looked for, and on how many it must occur to recur. */
export const RECURRENCE_DAYS = 7;
const RECURRENCE_AT_LEAST = 3;

/** The start of each of the seven host days, oldest first; the last runs to `nowMs`. */
export function recurrenceDays(nowMs: number, timeZone: string): number[] {
  // Calendar boundaries of the host's zone, so a day's bucket does not move
  // as the query time does.
  return Array.from({ length: RECURRENCE_DAYS }, (_, i) =>
    midnightIn(timeZone, nowMs, i + 1 - RECURRENCE_DAYS),
  );
}

/**
 * Each recurring class, the one with the most rows first, on every
 * repository or on `repo` alone.
 */
export function recurringClasses(
  db: Database,
  nowMs: number,
  timeZone: string,
  repo?: string,
): RecurringClass[] {
  const starts = recurrenceDays(nowMs, timeZone);
  const groups = new Map<string, RecurringClass>();
  // One grouped query per day: the result follows the classes, not the
  // sessions, however busy the week was.
  const perDay = db.query(
    `SELECT bucket, repo, stage, COUNT(*) AS n FROM log
     WHERE at_ms >= ?1 AND at_ms <= ?2 AND (?3 IS NULL OR repo = ?3)
       AND ${COUNTED}
     GROUP BY bucket, repo, stage`,
  );
  starts.forEach((start, day) => {
    const end =
      day + 1 < starts.length ? (starts[day + 1] ?? nowMs) - 1 : nowMs;
    const found = perDay.all(start, end, repo ?? null) as Array<{
      bucket: string;
      repo: string;
      stage: string;
      n: number;
    }>;
    for (const row of found) {
      const key = JSON.stringify([row.bucket, row.repo, row.stage]);
      const group = groups.get(key) ?? {
        class: row.bucket,
        repo: row.repo,
        stage: row.stage,
        nights: Array.from({ length: RECURRENCE_DAYS }, () => false),
        rows: 0,
      };
      group.nights[day] = true;
      group.rows += row.n;
      groups.set(key, group);
    }
  });
  const recurs = (g: RecurringClass) =>
    g.nights.filter(Boolean).length >= RECURRENCE_AT_LEAST;
  return [...groups.values()]
    .filter(recurs)
    .map((g) => (settlesByRedrive(g) ? unsettled(db, g, starts, nowMs) : g))
    .filter(recurs)
    .sort((a, b) => b.rows - a.rows);
}

/** A drive's stalls counted again without the ones the re-drive followed. */
function unsettled(
  db: Database,
  group: RecurringClass,
  starts: readonly number[],
  nowMs: number,
): RecurringClass {
  const left = occurrences(db, group, starts[0] ?? nowMs, nowMs).filter(
    (o) => o.redrive === null,
  );
  const nights = starts.map((start, day) => {
    const end =
      day + 1 < starts.length ? (starts[day + 1] ?? nowMs) - 1 : nowMs;
    return left.some((o) => o.atMs >= start && o.atMs <= end);
  });
  return { ...group, nights, rows: left.length };
}
