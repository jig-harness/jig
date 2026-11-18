/**
 * What `jig dispatch dashboard` asks of the outcome log (`log.ts`), in SQL over
 * the log table, all in one read transaction so a tick committing between two
 * queries shows in neither. A question about yesterday is a filter, not a
 * report: nothing is generated per run and nothing is written to disk.
 *
 * The rows of `notices_read`, which the `notify` stage records every tick
 * (`notices-read.ts`), are left out of the rows, the total and the counts
 * unless the class filter names their bucket: they are a measure's
 * observations, not something that ended or a cause a person reads.
 */
import type { RowsAnswer, WindowName } from "./dashboard-contract.ts";
import { midnightIn } from "./host-time.ts";
import { OUTCOME_CLASSES, rowsOf } from "./log.ts";
import { NOTICES_READ } from "./notices-read.ts";
import { recurringClasses } from "./recurring.ts";
import { existingStateDb } from "./state.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";

/** What the page filters the log by; an absent field filters nothing. */
interface LogFilter {
  window: WindowName;
  fromMs: number;
  toMs: number;
  repo?: string;
  stage?: string;
  account?: string;
  class?: string;
  /** Rows whose reason contains this text, whatever the case of its ASCII letters. */
  reason?: string;
  /** Ended rows whose closing report names this `cause`. */
  cause?: string;
  /** Ended rows whose closing report this writer wrote (`by`; `none` for a run that left none). */
  by?: string;
  /** The rows of one piece of work, as rows name it (`PR #12`, `ENG-4`): its page. */
  target?: string;
}

/** The bucket a `notices_read` row counts under, which only a class filter naming it shows. */
const HIDDEN_BUCKET = `event: ${NOTICES_READ}`;

/** The most rows one query returns; the counts still cover every row the filter keeps. */
const MAX_ROWS = 5000;

const DAY_MS = 86_400_000;

/** The filter's fields but the class; `counts` ignores the class so another can still be chosen. */
const KEPT_ANY_CLASS = `at_ms >= ?1 AND at_ms <= ?2
         AND (?3 IS NULL OR repo = ?3)
         AND (?4 IS NULL OR stage = ?4)
         AND (?5 IS NULL OR account = ?5)
         AND (?6 IS NULL OR instr(lower(reason), lower(?6)) > 0)
         AND (?7 IS NULL OR cause = ?7)
         AND (?8 IS NULL OR report_by = ?8)
         AND (?9 IS NULL OR target = ?9)
         AND (bucket <> ?11 OR ?10 IS ?11)`;

const KEPT = `${KEPT_ANY_CLASS} AND (?10 IS NULL OR bucket = ?10)`;

/** Every query's arguments: the filter's fields, the class among them, and the bucket only a class filter shows. */
function filterArgs(f: LogFilter) {
  return [
    f.fromMs,
    f.toMs,
    f.repo ?? null,
    f.stage ?? null,
    f.account ?? null,
    f.reason ?? null,
    f.cause ?? null,
    f.by ?? null,
    f.target ?? null,
    f.class ?? null,
    HIDDEN_BUCKET,
  ];
}

function text(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function time(params: URLSearchParams, name: string): number | undefined {
  const value = text(params, name);
  const ms = value === undefined ? Number.NaN : parseMs(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The window a query names: `from` and `to` (either defaults as `today` does) over `window`; today when it names neither. */
function windowOf(
  params: URLSearchParams,
  nowMs: number,
  timeZone: string,
): Pick<LogFilter, "window" | "fromMs" | "toMs"> {
  const from = time(params, "from");
  const to = time(params, "to");
  if (from !== undefined || to !== undefined)
    return {
      window: "range",
      fromMs: from ?? midnightIn(timeZone, nowMs),
      toMs: to ?? nowMs,
    };
  const window = text(params, "window");
  if (window === "yesterday")
    return {
      window,
      fromMs: midnightIn(timeZone, nowMs, -1),
      toMs: midnightIn(timeZone, nowMs) - 1,
    };
  if (window === "7d")
    return { window, fromMs: nowMs - 7 * DAY_MS, toMs: nowMs };
  if (window === "30d")
    return { window, fromMs: nowMs - 30 * DAY_MS, toMs: nowMs };
  return { window: "today", fromMs: midnightIn(timeZone, nowMs), toMs: nowMs };
}

function parseFilter(
  params: URLSearchParams,
  nowMs: number,
  timeZone: string,
): LogFilter {
  const filter: LogFilter = windowOf(params, nowMs, timeZone);
  for (const name of [
    "repo",
    "stage",
    "account",
    "class",
    "reason",
    "cause",
    "by",
    "target",
  ] as const) {
    const value = text(params, name);
    if (value !== undefined) filter[name] = value;
  }
  return filter;
}

/** The columns whose values the page offers as choices. */
const CHOICES = [
  "repo",
  "stage",
  "account",
  "bucket",
  "cause",
  "report_by",
] as const;

/** The values each field takes in the window, for the page's choices. */
function windowValues(
  db: NonNullable<ReturnType<typeof existingStateDb>>,
  f: LogFilter,
): Record<(typeof CHOICES)[number], string[]> {
  const values = (field: (typeof CHOICES)[number]): string[] =>
    (
      db
        .query(
          `SELECT DISTINCT ${field} AS value FROM log
           WHERE at_ms >= ? AND at_ms <= ? AND ${field} IS NOT NULL`,
        )
        .all(f.fromMs, f.toMs) as Array<{ value: string }>
    )
      .map((r) => r.value)
      .sort((a, b) => a.localeCompare(b));
  const out = {} as Record<(typeof CHOICES)[number], string[]>;
  for (const field of CHOICES) out[field] = values(field);
  return out;
}

/** The answer to one query over the log: the page's `GET /rows`. */
export function queryLog(
  params: URLSearchParams,
  nowMs: number,
  root: string,
  timeZone: string,
): RowsAnswer {
  const filter = parseFilter(params, nowMs, timeZone);
  const window = {
    window: filter.window,
    from: isoFromMs(filter.fromMs),
    to: isoFromMs(filter.toMs),
  };
  const db = existingStateDb(root);
  if (db === null)
    return {
      ...window,
      counts: {},
      total: 0,
      rows: [],
      truncated: false,
      options: {
        repo: [],
        stage: [],
        account: [],
        class: [...OUTCOME_CLASSES],
        cause: [],
        by: [],
      },
      recurring: [],
      logHasRows: false,
    };
  return db.transaction(() => {
    const args = filterArgs(filter);
    const counted = db
      .query(
        `SELECT bucket, COUNT(*) AS n FROM log WHERE ${KEPT_ANY_CLASS} GROUP BY bucket`,
      )
      .all(...args) as Array<{ bucket: string; n: number }>;
    const total = (
      db.query(`SELECT COUNT(*) AS n FROM log WHERE ${KEPT}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = rowsOf(
      db
        .query(
          `SELECT row FROM log WHERE ${KEPT}
           ORDER BY at_ms DESC, seq DESC LIMIT ${MAX_ROWS}`,
        )
        .all(...args) as Array<{ row: string }>,
    );
    const values = windowValues(db, filter);
    return {
      ...window,
      counts: Object.fromEntries(counted.map((c) => [c.bucket, c.n])),
      total,
      rows,
      truncated: total > rows.length,
      options: {
        repo: values.repo,
        stage: values.stage,
        account: values.account,
        class: [...new Set([...OUTCOME_CLASSES, ...values.bucket])],
        cause: values.cause,
        by: values.report_by,
      },
      recurring: recurringClasses(db, nowMs, timeZone),
      logHasRows: db.query("SELECT 1 FROM log LIMIT 1").get() !== null,
    };
  })();
}
