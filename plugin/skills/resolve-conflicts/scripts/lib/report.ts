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
import type { PullRequestHead, Resolution } from "./replay.ts";
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
  /** Which sides hold the path, as `conflict-map.ts` names it. */
  kind: Kind;
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
  commit: string;
  /** First parent (ours) and second parent (theirs). */
  parents: [string, string];
  date: string;
  subject: string;
  /** The pull request the subject names (`Merge pull request #12 …`, `… (#12)`). */
  pullRequest: number | null;
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
  reason: "octopus" | "replay-failed";
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

export const LIMITS = [
  "It sees only merge commits that still exist: a conflict resolved during a rebase, a cherry-pick or a revert, or on a branch deleted after a squash merge, leaves nothing to replay.",
  "It sees the merges this clone's refs reach; another clone, or one with more refs fetched, can reach more.",
  "It counts a conflict once for each merge that meets it again.",
  "A merge git combines cleanly but that breaks the build is not a conflict to it.",
  "Merges of more than two parents (octopus merges) are not replayed; they are listed as skipped.",
  "Causes are recognised from the regions' shape; the hand-check below says how often each was right.",
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
function top(map: Partial<Record<Cause, number>>): Cause {
  let best: Cause = "overlap";
  let most = -1;
  for (const cause of CAUSES)
    if ((map[cause] ?? 0) > most) {
      most = map[cause] ?? 0;
      best = cause;
    }
  return best;
}

/** The Monday (UTC) of the week holding `date`. */
export function weekOf(date: string): string {
  const day = new Date(date);
  const monday = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
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
    if (merge.date > summary.lastConflict) summary.lastConflict = merge.date;
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
        const topCause = top(summary.causes);
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

export function buildReport(input: {
  range: Range;
  hotspotMinMerges: number;
  merges: MergeRecord[];
  skipped: SkippedMerge[];
  confidence: Confidence | null;
  now?: Date;
}): Report {
  const { merges, hotspotMinMerges, confidence } = input;
  const tallies = new Tallies();
  for (const merge of merges) tallies.addMerge(merge);
  const paths = tallies.paths(hotspotMinMerges);
  return {
    schema: SCHEMA,
    generatedAt: (input.now ?? new Date()).toISOString(),
    range: input.range,
    hotspotMinMerges,
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
    weeks: [...tallies.byWeek.values()].sort((a, b) =>
      a.week.localeCompare(b.week),
    ),
    merges,
    skipped: input.skipped,
    confidence,
    limits: LIMITS,
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
    totals.skipped > 0
      ? `; ${totals.skipped} skipped (listed with --json)`
      : "";
  return [
    `Merge conflicts, ${report.range.label}`,
    `${plural(totals.merges, "merge")} replayed, ${totals.conflicted} conflicted${mechanical}${skipped}`,
  ];
}

function pathLines(report: Report, limit: number): string[] {
  const shown = limit > 0 ? report.paths.slice(0, limit) : report.paths;
  const width = Math.min(60, Math.max(...shown.map((p) => p.path.length)));
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
    "",
    "Per week, conflicted merges by cause:",
    ...report.weeks.map(
      (w) =>
        `  ${w.week}  ${w.conflicted} of ${plural(w.merges, "merge")} conflicted${w.conflicted > 0 ? `: ${causeList(w.causes)}` : ""}`,
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
      ? ["", "No merge in the range conflicted."]
      : [...pathLines(report, limit), ...summaryLines(report)];
  return [
    ...headline(report),
    ...body,
    ...confidenceLines(report.confidence),
    "",
    "Limits:",
    ...report.limits.map((line) => `  - ${line}`),
  ].join("\n");
}
