/**
 * The scoreboard `GET /scoreboard` serves: six numbers over a window of the
 * outcome log (`log.ts`), one row per release that ran something in it, so a
 * person sees whether a release made the line better or worse. A row counts
 * under the release its own record names (`release`, which the records carry
 * once the tick writes it); a record that names none counts under `null`, the
 * time before releases were recorded. Nothing is written and nothing is read
 * but the log and, for the slots the line has, the newest line.
 *
 * The numbers of one release row:
 *
 * - `merged`: distinct pull requests whose drive ended `merged`;
 * - `answersPerMerge`: answered parks over `merged`, `null` with no merge;
 * - `medianNeedAgeMs`: the median wait of answered parks, `null` with none;
 * - `sessionHoursNotConverged`: hours the runs held that ended in neither
 *   `converged` nor `merged`;
 * - `idleSlotHours`: the account slots the line has over the release's span,
 *   less the hours its runs held one, never below zero; the span runs from
 *   the release's first run to the next release's first, the newest to the
 *   window's end, so the figure is an estimate from the caps the newest line
 *   shows; `null` when no line has been written;
 * - `medianRounds`: the median rounds of drives that converged or merged.
 *
 * A **regression** is an end cause (a closing report's `cause`) that no run
 * had in the 14 days before its first run under a release and that has at
 * least three runs under that release: it names the release. Runs that name
 * no release name none. The claim reaches only as far back as the rows read:
 * a release's first run is its first within the window and the days before it.
 */
import { median } from "../../skills/drive-pr/scripts/lib/fractal.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { LineSnapshot } from "./dashboard-contract.ts";
import type { EndedRow, LogRow } from "./log.ts";
import { rowsOf } from "./log.ts";
import { existingStateDb } from "./state.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** How long a cause must have been absent for its return to be new. */
const ABSENT_DAYS = 14;

/** How many runs under one release make a new cause a regression. */
const REGRESSION_RUNS = 3;

/** The windows `GET /scoreboard` offers, in days. */
const WINDOWS = { "7d": 7, "30d": 30 } as const;
export type ScoreboardWindow = keyof typeof WINDOWS;

/** One release's row. */
export interface ScoreboardRow {
  /** The release the records name; `null` for those that name none. */
  release: string | null;
  /** The first and the last time a run of it started or ended in the window. */
  firstAt: string;
  lastAt: string;
  /** Ended runs counted under it. */
  runs: number;
  merged: number;
  answers: number;
  answersPerMerge: number | null;
  medianNeedAgeMs: number | null;
  sessionHoursNotConverged: number;
  idleSlotHours: number | null;
  medianRounds: number | null;
}

/** A cause new under a release. */
export interface Regression {
  release: string;
  cause: string;
  /** Runs that ended with it under the release. */
  runs: number;
  /** When its first run under the release ended. */
  firstAt: string;
}

/** `GET /scoreboard`. */
export interface ScoreboardAnswer {
  window: ScoreboardWindow;
  from: string;
  to: string;
  /** The account slots the newest line shows; `null` when none was written. */
  slots: number | null;
  /** The newest release first. */
  rows: ScoreboardRow[];
  regressions: Regression[];
}

/** A row as it may carry a release: the field belongs to the records, not to this reader's types. */
type Released = LogRow & { release?: unknown };

/** The release a row names; `null` when it names none. */
function releaseOf(row: LogRow): string | null {
  const release = (row as Released).release;
  return typeof release === "string" && release !== "" ? release : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function isEnded(row: LogRow): row is EndedRow {
  return row.kind === "ended";
}

function isAnswered(row: LogRow): boolean {
  return row.kind === "event" && row.park?.outcome === "answered";
}

/** Milliseconds of `[start, end]` that lie within `[from, to]`. */
function overlap(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

/** Where a run started, from its end and its duration; its end when it recorded none. */
function startOf(row: EndedRow): number {
  const end = parseMs(row.at);
  return end - (row.durationMs ?? 0);
}

/** The ended runs that name a cause, by cause. */
function runsByCause(rows: readonly LogRow[]): Map<string, EndedRow[]> {
  const byCause = new Map<string, EndedRow[]>();
  for (const row of rows.filter(isEnded)) {
    if (row.cause === undefined) continue;
    const runs = byCause.get(row.cause);
    if (runs === undefined) byCause.set(row.cause, [row]);
    else runs.push(row);
  }
  return byCause;
}

/** Whether `cause`, whose runs are `runs`, is new under `release`: no run of it in the `ABSENT_DAYS` before its first run there, which falls in `[fromMs, toMs]`, and at least `REGRESSION_RUNS` runs there. */
function newUnder(
  cause: string,
  release: string,
  runs: readonly EndedRow[],
  fromMs: number,
  toMs: number,
): Regression | null {
  const under = runs
    .filter((r) => releaseOf(r) === release)
    .sort((a, b) => parseMs(a.at) - parseMs(b.at));
  const [firstRun] = under;
  if (firstRun === undefined || under.length < REGRESSION_RUNS) return null;
  const first = parseMs(firstRun.at);
  if (first < fromMs || first > toMs) return null;
  const seenBefore = runs.some((r) => {
    const at = parseMs(r.at);
    return at < first && at >= first - ABSENT_DAYS * DAY_MS;
  });
  return seenBefore
    ? null
    : { release, cause, runs: under.length, firstAt: firstRun.at };
}

/**
 * The causes new under a release. `rows` must reach `ABSENT_DAYS` back from
 * `fromMs`: a cause is named only when its first run under the release is
 * inside the window, so the days before it are always among the rows.
 */
export function regressionsOf(
  rows: readonly LogRow[],
  toMs: number,
  fromMs: number,
): Regression[] {
  const found: Regression[] = [];
  for (const [cause, runs] of runsByCause(rows))
    for (const release of new Set(runs.map(releaseOf)))
      if (release !== null) {
        const regression = newUnder(cause, release, runs, fromMs, toMs);
        if (regression !== null) found.push(regression);
      }
  return found.sort((a, b) => parseMs(b.firstAt) - parseMs(a.firstAt));
}

/** One release's records in the window, and when its first run began (not before the window). */
interface Group {
  release: string | null;
  group: LogRow[];
  from: number;
}

/** The ended and answered-park rows of the window, grouped by the release they name, the oldest release first. */
function groupsOf(
  rows: readonly LogRow[],
  fromMs: number,
  toMs: number,
): Group[] {
  const byRelease = new Map<string | null, LogRow[]>();
  const inWindow = rows.filter((row) => {
    const at = parseMs(row.at);
    return at >= fromMs && at <= toMs;
  });
  // The groups and their spans come from runs; an answer joins the group of
  // its release only when that release ran something in the window.
  for (const row of inWindow.filter(isEnded)) {
    const release = releaseOf(row);
    const group = byRelease.get(release);
    if (group === undefined) byRelease.set(release, [row]);
    else group.push(row);
  }
  for (const row of inWindow.filter(isAnswered))
    byRelease.get(releaseOf(row))?.push(row);
  const startsAt = (group: LogRow[]): number =>
    group.reduce(
      (least, r) => Math.min(least, isEnded(r) ? startOf(r) : parseMs(r.at)),
      Number.POSITIVE_INFINITY,
    );
  return [...byRelease.entries()]
    .map(([release, group]) => ({
      release,
      group,
      from: Math.max(fromMs, startsAt(group)),
    }))
    .sort((a, b) => a.from - b.from);
}

/** The row of one release, whose span runs to `spanTo`. */
function rowOf(
  { release, group, from }: Group,
  spanTo: number,
  slots: number | null,
  allRuns: readonly EndedRow[],
  windowFrom: number,
  windowTo: number,
): ScoreboardRow {
  const runs = group.filter(isEnded);
  const merged = new Set(
    runs
      .filter((r) => r.class === "merged")
      .map((r) => `${r.repo} ${r.target}`),
  ).size;
  const answered = group.filter(isAnswered);
  const waits = answered.flatMap((r) =>
    r.kind === "event" && r.durationMs !== undefined ? [r.durationMs] : [],
  );
  const notConvergedMs = runs
    .filter((r) => r.class !== "converged" && r.class !== "merged")
    .reduce(
      (sum, r) =>
        sum + overlap(startOf(r), parseMs(r.at), windowFrom, windowTo),
      0,
    );
  // Every run's slot occupancy over the span counts, whichever release ran
  // it; a launch still running has no row yet, so the figure is an estimate.
  const heldMs = allRuns.reduce(
    (sum, r) => sum + overlap(startOf(r), parseMs(r.at), from, spanTo),
    0,
  );
  const finished = runs
    .filter((r) => r.class === "converged" || r.class === "merged")
    .flatMap((r) => (typeof r.rounds === "number" ? [r.rounds] : []));
  return {
    release,
    firstAt: isoFromMs(from),
    lastAt: isoFromMs(
      group.reduce((latest, r) => Math.max(latest, parseMs(r.at)), 0),
    ),
    runs: runs.length,
    merged,
    answers: answered.length,
    answersPerMerge: merged === 0 ? null : round2(answered.length / merged),
    medianNeedAgeMs: median(waits),
    sessionHoursNotConverged: round2(notConvergedMs / HOUR_MS),
    idleSlotHours:
      slots === null
        ? null
        : round2(Math.max(0, (slots * (spanTo - from) - heldMs) / HOUR_MS)),
    medianRounds: median(finished),
  };
}

/** The scoreboard of `rows` over `[fromMs, toMs]`; `rows` may reach back `ABSENT_DAYS` before the window for the regressions. */
export function scoreboardOf(
  rows: readonly LogRow[],
  window: ScoreboardWindow,
  fromMs: number,
  toMs: number,
  slots: number | null,
): ScoreboardAnswer {
  const groups = groupsOf(rows, fromMs, toMs);
  const allRuns = rows.filter(isEnded);
  return {
    window,
    from: isoFromMs(fromMs),
    to: isoFromMs(toMs),
    slots,
    rows: groups
      .map((g, i) =>
        rowOf(g, groups[i + 1]?.from ?? toMs, slots, allRuns, fromMs, toMs),
      )
      .reverse(),
    regressions: regressionsOf(rows, toMs, fromMs),
  };
}

/** The window a query names: `7d` unless it says `30d`. */
function windowOf(params: URLSearchParams): ScoreboardWindow {
  const name = params.get("window")?.trim();
  return name === "30d" ? "30d" : "7d";
}

/** The account slots a line has: the sum of its accounts' caps, which is what the machine file grants. */
function slotsOf(line: LineSnapshot | null): number | null {
  return line === null
    ? null
    : line.accounts.reduce((sum, a) => sum + a.cap, 0);
}

/** The most rows one request reads, newest first; an older tail is dropped, so the figures are an estimate on a log this busy. */
const MAX_ROWS = 50_000;

/** The rows a scoreboard reads: every ended row, and the rows of answered parks, from `fromMs` to `toMs`. */
function scoreboardRows(fromMs: number, toMs: number, root: string): LogRow[] {
  const db = existingStateDb(root);
  if (db === null) return [];
  return rowsOf(
    (
      db
        .query(
          `SELECT row FROM log
           WHERE at_ms >= ? AND at_ms <= ? AND (kind = 'ended' OR bucket = 'event: park-answered')
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(fromMs, toMs, MAX_ROWS) as Array<{ row: string }>
    ).reverse(),
  );
}

/** `GET /scoreboard` over the log under `root`, with `line` for the slots. */
export function readScoreboard(
  params: URLSearchParams,
  nowMs: number,
  root: string,
  line: LineSnapshot | null,
): ScoreboardAnswer {
  const window = windowOf(params);
  const fromMs = nowMs - WINDOWS[window] * DAY_MS;
  return scoreboardOf(
    scoreboardRows(fromMs - ABSENT_DAYS * DAY_MS, nowMs, root),
    window,
    fromMs,
    nowMs,
    slotsOf(line),
  );
}
