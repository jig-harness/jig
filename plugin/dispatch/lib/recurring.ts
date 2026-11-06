/**
 * The one definition of a recurring class, which the dashboard lists
 * (`dashboard-log.ts`) and the reflection route records (`reflection-route.ts`):
 * a bad class (any but `converged`, `merged` and `parked for a person`) of one
 * stage on one repository, on at least three of the last seven host days,
 * today included. It counts the outcome log's ended rows and the event rows
 * that carry a class, such as a drive stopped for a person; an event row that
 * carries none (a drift, a wait, a nudge, a hold) stays out, however often it
 * occurs.
 */
import type { Database } from "bun:sqlite";
import type { RecurringClass } from "./dashboard-contract.ts";
import { midnightIn } from "./host-time.ts";
import { OUTCOME_CLASSES, type OutcomeClass } from "./log.ts";

/** The host days a class is looked for, and on how many it must occur to recur. */
export const RECURRENCE_DAYS = 7;
export const RECURRENCE_AT_LEAST = 3;

/** The classes that are not a stage finishing badly: the finished-well ones, and a park, which is a person's to answer. */
export const NOT_BAD: readonly OutcomeClass[] = [
  "converged",
  "merged",
  "parked for a person",
];

const quoted = (names: readonly string[]) =>
  names.map((name) => `'${name.replaceAll("'", "''")}'`).join(", ");

/**
 * The rows a recurrence counts, in SQL over the log table: an ended row of a
 * bad class, or an event row whose bucket is a class (an event row that
 * carries none is bucketed under its event).
 */
const COUNTED = `bucket NOT IN (${quoted(NOT_BAD)})
  AND (kind = 'ended' OR bucket IN (${quoted(OUTCOME_CLASSES)}))`;

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
  return [...groups.values()]
    .filter((g) => g.nights.filter(Boolean).length >= RECURRENCE_AT_LEAST)
    .sort((a, b) => b.rows - a.rows);
}

/** The reasons a recurring class's rows give most often over its seven days, as the log holds them, with how many rows give each. */
export function commonReasons(
  db: Database,
  recurring: Pick<RecurringClass, "class" | "repo" | "stage">,
  nowMs: number,
  timeZone: string,
  limit = 3,
): Array<{ reason: string; rows: number }> {
  const [from] = recurrenceDays(nowMs, timeZone);
  return (
    db
      .query(
        `SELECT reason, COUNT(*) AS n FROM log
         WHERE at_ms >= ? AND at_ms <= ? AND repo = ? AND stage = ? AND bucket = ?
           AND ${COUNTED}
         GROUP BY reason ORDER BY n DESC, reason LIMIT ?`,
      )
      .all(
        from ?? nowMs,
        nowMs,
        recurring.repo,
        recurring.stage,
        recurring.class,
        limit,
      ) as Array<{ reason: string; n: number }>
  ).map((r) => ({ reason: r.reason, rows: r.n }));
}
