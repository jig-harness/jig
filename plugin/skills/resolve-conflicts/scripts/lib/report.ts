/**
 * The merge-conflict report: the replayed merges' records summed up by path,
 * by cause and by week, as a versioned JSON object (`merge-conflicts/v1`)
 * and as terminal text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { CAUSES, type Cause, remedyFor, REMEDIES } from "./causes.ts";
import type { PathClass } from "./classify.ts";
import type { PullRequestHead, Resolution, SubjectBranches } from "./replay.ts";
import type { Kind } from "./snapshot.ts";

export const SCHEMA = "merge-conflicts/v1";

export interface RegionRecord {
  /** 1-based lines of the region's opening and closing markers in the merged file. */
  start: number;
  end: number;
  cause: Cause;
  /** How many lines each side of the region holds. */
  lines: { ours: number; base: number; theirs: number };
}

export interface PathRecord {
  path: string;
  /** Which sides hold the path, as `conflict-map.ts` names it; null when git reports its conflict only in a message. */
  kind: Kind | null;
  /** Git's own kinds of conflict for the path (`contents`, `modify/delete`, `binary`, …). */
  conflicts: string[];
  class: PathClass;
  /** The causes of its regions, or its one path-level cause, in cause order. */
  causes: Cause[];
  regions: RegionRecord[];
  mechanical: boolean;
  /** The decision the merge's `Conflicts resolved:` section recorded for the path. */
  resolution: Resolution | null;
}

export interface MergeRecord {
  /** The kind of operation; a replayed record is always a merge. */
  operation: "merge";
  commit: string;
  /** First parent (ours) and second parent (theirs). */
  parents: [string, string];
  date: string;
  subject: string;
  /** The pull request the subject names (`Merge pull request #12 …`, `… (#12)`). */
  pullRequest: number | null;
  /** The branches the subject names: the one merged in, and the one merged into. */
  branches: SubjectBranches;
  /** The fetched pull-request head refs each parent is the tip of. */
  parentHeads: { ours: PullRequestHead[]; theirs: PullRequestHead[] };
  conflicted: boolean;
  /** Null for a clean merge. */
  mechanical: boolean | null;
  paths: PathRecord[];
  /** Lines of the resolution section naming a path the replay found no conflict in. */
  unmatchedResolutions: ({ path: string } & Resolution)[];
}

export interface SkippedMerge {
  commit: string;
  date: string;
  subject: string;
  reason: "octopus" | "shallow" | "replay-failed";
  detail: string;
}

export interface Accuracy {
  checked: number;
  correct: number;
  /** What the wrong ones had in common, where that is known. */
  note?: string;
}

export interface Confidence {
  /** What the sample was drawn from, and when it was checked. */
  source: string;
  checkedOn: string;
  causes: Partial<Record<Cause, Accuracy>>;
}

export interface Range {
  since: string | null;
  until: string | null;
  /** How the range was chosen, for people: `last 30 days`, `all history`, … */
  label: string;
}

export interface PathSummary {
  path: string;
  merges: number;
  /** Regions per cause; a path conflicting without text regions counts once per merge. */
  causes: Partial<Record<Cause, number>>;
  topCause: Cause;
  remedy: string;
  hotspot: boolean;
  lastConflict: string;
}

export interface CauseSummary {
  cause: Cause;
  regions: number;
  paths: number;
  merges: number;
  remedy: string;
  accuracy: Accuracy | null;
}

export interface WeekSummary {
  /** The week's Monday (UTC), `YYYY-MM-DD`. */
  week: string;
  merges: number;
  conflicted: number;
  /** Conflicted merges with at least one region (or path) of each cause. */
  causes: Partial<Record<Cause, number>>;
}

export interface Report {
  schema: typeof SCHEMA;
  generatedAt: string;
  range: Range;
  hotspotMinMerges: number;
  /** A shallow clone: merges whose history it cuts are skipped, so the results are partial. */
  shallow: boolean;
  totals: {
    merges: number;
    conflicted: number;
    mechanical: number;
    paths: number;
    regions: number;
    skipped: number;
  };
  causes: CauseSummary[];
  paths: PathSummary[];
  hotspots: string[];
  weeks: WeekSummary[];
  merges: MergeRecord[];
  skipped: SkippedMerge[];
  confidence: Confidence | null;
  limits: string[];
}

const SHALLOW_LIMIT =
  "This clone is shallow: a merge whose history its boundary cuts is skipped, so the results are partial. Fetch the full history (git fetch --unshallow) for a complete report.";

export const LIMITS = [
  "It sees only merge commits that still exist: a conflict resolved during a rebase, a cherry-pick or a revert, or on a branch deleted after a squash merge, leaves nothing to replay.",
  "It sees the merges this clone's refs reach; another clone, or one with more refs fetched, can reach more.",
  "It counts a conflict once for each merge that meets it again.",
  "A merge git combines cleanly but that breaks the build is not a conflict to it.",
  "Merges of more than two parents (octopus merges) are not replayed; they are listed as skipped.",
  "Causes are recognised from the regions' shape; the hand-check records how often each was right.",
];

/** The hand-checked accuracy of each cause, shipped beside the skill; null when it is missing or unreadable. */
export function loadConfidence(
  file = join(import.meta.dir, "..", "..", "references", "cause-accuracy.json"),
): Confidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    swallow(
      err,
      "the hand-check record is unreadable: the report says none is recorded",
    );
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== "cause-accuracy/v1" ||
    typeof parsed.source !== "string" ||
    typeof parsed.checkedOn !== "string" ||
    !isRecord(parsed.causes)
  )
    return null;
  const causes: Partial<Record<Cause, Accuracy>> = {};
  for (const cause of CAUSES) {
    const entry = parsed.causes[cause];
    if (
      !isRecord(entry) ||
      typeof entry.checked !== "number" ||
      typeof entry.correct !== "number"
    )
      continue;
    causes[cause] = {
      checked: entry.checked,
      correct: entry.correct,
      ...(typeof entry.note === "string" ? { note: entry.note } : {}),
    };
  }
  return { source: parsed.source, checkedOn: parsed.checkedOn, causes };
}

/** The unit a cause is counted in: each region, or the path itself when it has none. */
function units(path: PathRecord): Cause[] {
  return path.regions.length > 0
    ? path.regions.map((r) => r.cause)
    : path.causes;
}

function add(map: Partial<Record<Cause, number>>, cause: Cause, n = 1): void {
  map[cause] = (map[cause] ?? 0) + n;
}

/** The most frequent cause; a tie goes to the earlier one in cause order. */
export function mostFrequentCause(map: Partial<Record<Cause, number>>): Cause {
  let best: Cause = "overlap";
  let most = -1;
  for (const cause of CAUSES)
    if ((map[cause] ?? 0) > most) {
      most = map[cause] ?? 0;
      best = cause;
    }
  return best;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Monday (UTC) of the week holding `date`. */
export function weekOf(date: string): string {
  // Day arithmetic on the instant, not Date.UTC, which reads a year below 100 as 19xx.
  const day = Math.floor(Date.parse(date) / DAY_MS) * DAY_MS;
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - weekday * DAY_MS).toISOString().slice(0, 10);
}

interface CauseTotal {
  regions: number;
  paths: Set<string>;
  merges: Set<string>;
}

/** The running sums `buildReport` collects, merge by merge. */
class Tallies {
  readonly byPath = new Map<string, PathSummary>();
  readonly byCause = new Map<Cause, CauseTotal>();
  readonly byWeek = new Map<string, WeekSummary>();
  regions = 0;

  addMerge(merge: MergeRecord): void {
    const week = weekOf(merge.date);
    const w = this.byWeek.get(week) ?? {
      week,
      merges: 0,
      conflicted: 0,
      causes: {},
    };
    this.byWeek.set(week, w);
    w.merges++;
    if (!merge.conflicted) return;
    w.conflicted++;
    const mergeCauses = new Set<Cause>();
    for (const path of merge.paths)
      for (const cause of this.addPath(merge, path)) mergeCauses.add(cause);
    for (const cause of mergeCauses) add(w.causes, cause);
  }

  /** Count one conflicted path of `merge`; returns its causes, one per unit. */
  private addPath(merge: MergeRecord, path: PathRecord): Cause[] {
    const summary = this.byPath.get(path.path) ?? {
      path: path.path,
      merges: 0,
      causes: {},
      topCause: "overlap",
      remedy: "",
      hotspot: false,
      lastConflict: merge.date,
    };
    this.byPath.set(path.path, summary);
    summary.merges++;
    // Committer dates keep their own offset: compare instants, not text.
    if (Date.parse(merge.date) > Date.parse(summary.lastConflict))
      summary.lastConflict = merge.date;
    const causes = units(path);
    for (const cause of causes) {
      this.regions++;
      add(summary.causes, cause);
      const c = this.byCause.get(cause) ?? {
        regions: 0,
        paths: new Set(),
        merges: new Set(),
      };
      this.byCause.set(cause, c);
      c.regions++;
      c.paths.add(path.path);
      c.merges.add(merge.commit);
    }
    return causes;
  }

  paths(hotspotMinMerges: number): PathSummary[] {
    return [...this.byPath.values()]
      .map((summary) => {
        const topCause = mostFrequentCause(summary.causes);
        return {
          ...summary,
          topCause,
          remedy: remedyFor(topCause, summary.path),
          hotspot: summary.merges >= hotspotMinMerges,
        };
      })
      .sort((a, b) => b.merges - a.merges || a.path.localeCompare(b.path));
  }

  causes(confidence: Confidence | null): CauseSummary[] {
    return CAUSES.flatMap((cause) => {
      const c = this.byCause.get(cause);
      if (c === undefined) return [];
      return [
        {
          cause,
          regions: c.regions,
          paths: c.paths.size,
          merges: c.merges.size,
          remedy: REMEDIES[cause],
          accuracy: confidence?.causes[cause] ?? null,
        },
      ];
    });
  }
}

const WEEK_MS = 7 * DAY_MS;

/**
 * Every week of the range, a week without a merge as a row of zeros, so a gap
 * shows. An open end of the range is the first or the last merge's week; a
 * range with only a start runs to now, or to a later merge (a clock ahead of
 * now) so that every merge counted has its week.
 */
function allWeeks(
  byWeek: ReadonlyMap<string, WeekSummary>,
  range: Range,
  merges: readonly MergeRecord[],
  now: Date,
): WeekSummary[] {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const merge of merges) {
    const at = Date.parse(merge.date);
    if (at < earliest) earliest = at;
    if (at > latest) latest = at;
  }
  const first = range.since !== null ? Date.parse(range.since) : earliest;
  const last =
    range.until !== null
      ? Date.parse(range.until) - 1
      : range.since !== null
        ? Math.max(now.getTime(), latest)
        : latest;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last)
    return [];
  const weeks: WeekSummary[] = [];
  for (
    let at = Date.parse(weekOf(new Date(first).toISOString()));
    at <= last;
    at += WEEK_MS
  ) {
    const week = new Date(at).toISOString().slice(0, 10);
    weeks.push(
      byWeek.get(week) ?? { week, merges: 0, conflicted: 0, causes: {} },
    );
  }
  return weeks;
}

export function buildReport(input: {
  range: Range;
  hotspotMinMerges: number;
  merges: MergeRecord[];
  skipped: SkippedMerge[];
  shallow?: boolean;
  confidence: Confidence | null;
  now?: Date;
}): Report {
  const { merges, hotspotMinMerges, confidence } = input;
  const tallies = new Tallies();
  for (const merge of merges) tallies.addMerge(merge);
  const paths = tallies.paths(hotspotMinMerges);
  const shallow = input.shallow ?? false;
  const now = input.now ?? new Date();
  return {
    schema: SCHEMA,
    generatedAt: now.toISOString(),
    range: input.range,
    hotspotMinMerges,
    shallow,
    totals: {
      merges: merges.length,
      conflicted: merges.filter((m) => m.conflicted).length,
      mechanical: merges.filter((m) => m.mechanical === true).length,
      paths: paths.length,
      regions: tallies.regions,
      skipped: input.skipped.length,
    },
    causes: tallies.causes(confidence),
    paths,
    hotspots: paths.filter((p) => p.hotspot).map((p) => p.path),
    weeks: allWeeks(tallies.byWeek, input.range, merges, now),
    merges,
    skipped: input.skipped,
    confidence,
    limits: shallow ? [SHALLOW_LIMIT, ...LIMITS] : LIMITS,
  };
}

function causeList(map: Partial<Record<Cause, number>>): string {
  return CAUSES.filter((cause) => (map[cause] ?? 0) > 0)
    .map((cause) => `${cause} ${map[cause]}`)
    .join(", ");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function headline(report: Report): string[] {
  const { totals } = report;
  const mechanical =
    totals.conflicted > 0
      ? ` (${totals.mechanical} mechanical: no structural path and no overlap region)`
      : "";
  const skipped =
    totals.skipped > 0 ? `; ${totals.skipped} skipped (listed below)` : "";
  return [
    `Merge conflicts, ${report.range.label}`,
    ...(report.shallow ? [`Partial: ${SHALLOW_LIMIT}`] : []),
    `${plural(totals.merges, "merge")} replayed, ${totals.conflicted} conflicted${mechanical}${skipped}`,
  ];
}

function pathLines(report: Report, limit: number): string[] {
  const shown = limit > 0 ? report.paths.slice(0, limit) : report.paths;
  const width = Math.min(
    60,
    shown.reduce((most, p) => Math.max(most, p.path.length), 0),
  );
  const out = ["", "Paths, most often first:"];
  for (const p of shown)
    out.push(
      `  ${p.path.padEnd(width)}  ${plural(p.merges, "merge")}${p.hotspot ? " (hotspot)" : ""}  ${causeList(p.causes)}`,
      `    ${p.topCause}: ${p.remedy}`,
    );
  if (shown.length < report.paths.length)
    out.push(
      `  … ${report.paths.length - shown.length} more (--limit 0 lists all)`,
    );
  return out;
}

/** The weekly trend, a run of weeks without a merge on one line. */
function weekLines(weeks: readonly WeekSummary[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i] as WeekSummary;
    if (w.merges > 0) {
      out.push(
        `  ${w.week}  ${w.conflicted} of ${plural(w.merges, "merge")} conflicted${w.conflicted > 0 ? `: ${causeList(w.causes)}` : ""}`,
      );
      continue;
    }
    let last = i;
    while ((weeks[last + 1]?.merges ?? 1) === 0) last++;
    const through = last > i ? ` – ${(weeks[last] as WeekSummary).week}` : "";
    out.push(`  ${w.week}${through}  no merges`);
    i = last;
  }
  return out;
}

function summaryLines(report: Report): string[] {
  const hotspots =
    report.hotspots.length > 0 ? report.hotspots.join(", ") : "none";
  return [
    "",
    `Hotspots (conflicted in at least ${plural(report.hotspotMinMerges, "merge")}): ${hotspots}`,
    "",
    "Causes:",
    ...report.causes.map(
      (c) =>
        `  ${c.cause.padEnd(11)} ${plural(c.regions, "region")} in ${plural(c.paths, "path")}, ${plural(c.merges, "merge")}: ${c.remedy}`,
    ),
  ];
}

function weeklyLines(report: Report): string[] {
  if (report.weeks.length === 0) return [];
  return [
    "",
    "Per week, conflicted merges by cause:",
    ...weekLines(report.weeks),
  ];
}

/** What the report found, when no path conflicted: none replayed, or none of those replayed conflicted. */
function noConflictLine(report: Report): string {
  if (report.totals.merges > 0) return "No replayed merge conflicted.";
  return report.totals.skipped > 0
    ? "No merge in the range was replayed: every one was skipped, so nothing is known about its conflicts."
    : "No merge in the range.";
}

function skippedLines(skipped: readonly SkippedMerge[]): string[] {
  if (skipped.length === 0) return [];
  return [
    "",
    "Skipped:",
    ...skipped.map(
      (s) => `  ${s.commit.slice(0, 12)} (${s.reason}): ${s.detail}`,
    ),
  ];
}

function accuracyLine(cause: Cause, a: Accuracy | undefined): string {
  const result =
    a === undefined || a.checked === 0
      ? "not checked: no region of this cause in the sample"
      : `${a.correct} of ${a.checked} correct`;
  return `  ${cause.padEnd(11)} ${result}${a?.note ? `; ${a.note}` : ""}`;
}

function confidenceLines(confidence: Confidence | null): string[] {
  const out = ["", "How sure the causes are (regions hand-checked):"];
  if (confidence === null) return [...out, "  no hand-check recorded"];
  return [
    ...out,
    `  ${confidence.source}, checked ${confidence.checkedOn}`,
    ...CAUSES.map((cause) => accuracyLine(cause, confidence.causes[cause])),
  ];
}

/** The report as terminal text; `limit` caps the paths listed (0: all). */
export function renderReport(report: Report, limit: number): string {
  const body =
    report.totals.conflicted === 0
      ? ["", noConflictLine(report), ...weeklyLines(report)]
      : [
          ...pathLines(report, limit),
          ...summaryLines(report),
          ...weeklyLines(report),
        ];
  return [
    ...headline(report),
    ...body,
    ...skippedLines(report.skipped),
    ...confidenceLines(report.confidence),
    "",
    "Limits:",
    ...report.limits.map((line) => `  - ${line}`),
  ].join("\n");
}
