/**
 * Conflict hotspots as reflection findings. The merge-conflict history
 * report of `resolve-conflicts` (`history.ts --json`, schema
 * `merge-conflicts/v1`) names the paths that conflicted again and again, each
 * with its most frequent cause and the change that removes it. Each hotspot
 * becomes one finding in the journal, its cause as the class, so the
 * reflection loop counts, groups and escalates a recurring cause like any
 * other class: there is no second escalation path.
 *
 * A hotspot is one finding per path and cause. Measured again while its
 * finding waits in the journal, the finding is revised to the new count. Once
 * the store holds it, a new measurement adds nothing, until the finding's fix
 * is implemented and the hotspot is measured again over merges that all came
 * after the fix: that is the cause recurring, and a finding of its own.
 */
import { readFileSync } from "node:fs";
import { isRecord } from "../../../../shared/guards.ts";
import {
  CAUSES,
  type Cause,
  SHAPES,
} from "../../../resolve-conflicts/scripts/lib/causes.ts";
import {
  type Accuracy,
  type PathSummary,
  type Report,
  SCHEMA,
} from "../../../resolve-conflicts/scripts/lib/report.ts";
import type { ComputedState, FindingEvent, FindingState } from "./events.ts";
import { ownerOf } from "./events.ts";
import {
  buildFinding,
  type FindingNote,
  noteFinding,
  readJournal,
  reviseFinding,
  unsent,
} from "./journal.ts";

/** The parts of the report a hotspot finding is written from. */
export interface HotspotReport {
  range: Pick<Report["range"], "since" | "label">;
  hotspotMinMerges: number;
  shallow: boolean;
  totalMerges: number;
  hotspots: PathSummary[];
  /** How many merges the replay skipped, by reason. */
  skipped: Record<string, number>;
  /** Each cause's hand-checked accuracy; null when no hand-check was recorded. */
  accuracy: Partial<Record<Cause, Accuracy>> | null;
}

function badReport(file: string, problem: string): Error {
  return new Error(
    `${file} is not a ${SCHEMA} report (history.ts --json): ${problem}`,
  );
}

function isCause(value: unknown): value is Cause {
  return (CAUSES as readonly unknown[]).includes(value);
}

function isText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isWhole(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCount(value: unknown): boolean {
  return isWhole(value) && (value as number) >= 1;
}

function isDate(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Regions per cause: each key a cause, each value a count of regions. */
function isCauseCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, n]) => isCause(key) && isWhole(n))
  );
}

function isAccuracy(value: unknown): boolean {
  return (
    isRecord(value) &&
    isWhole(value.checked) &&
    isWhole(value.correct) &&
    (value.correct as number) <= (value.checked as number)
  );
}

/** The hand-check: null, or each cause's accuracy. */
function isConfidence(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      isRecord(value.causes) &&
      Object.entries(value.causes).every(
        ([key, accuracy]) => isCause(key) && isAccuracy(accuracy),
      ))
  );
}

function isSkipped(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => isRecord(entry) && isText(entry.reason))
  );
}

/** A field, the check its value must pass, and what to say when it fails. */
type Check = [field: string, ok: (value: unknown) => boolean, problem: string];

const REPORT_CHECKS: readonly Check[] = [
  ["schema", (value) => value === SCHEMA, `its schema is not ${SCHEMA}`],
  [
    "range",
    (value) =>
      isRecord(value) &&
      typeof value.label === "string" &&
      (value.since === null || isDate(value.since)),
    "range is missing, or its since is not a date",
  ],
  [
    "totals",
    (value) => isRecord(value) && isWhole(value.merges),
    "totals.merges is not a count",
  ],
  ["hotspotMinMerges", isCount, "hotspotMinMerges is missing"],
  ["paths", Array.isArray, "paths is missing"],
  ["hotspots", Array.isArray, "hotspots is missing"],
  ["skipped", isSkipped, "skipped is not a list of skipped merges"],
  ["confidence", isConfidence, "confidence is not a hand-check"],
];

const PATH_CHECKS: readonly Check[] = [
  ["merges", isCount, "merges is not a count"],
  ["topCause", isCause, "topCause is not a cause"],
  ["remedy", isText, "remedy is missing"],
  ["causes", isCauseCounts, "causes is not a count of regions per cause"],
  ["lastConflict", isDate, "lastConflict is not a date"],
];

function firstProblem(
  value: Record<string, unknown>,
  checks: readonly Check[],
): string | null {
  const failed = checks.find(([field, ok]) => !ok(value[field]));
  return failed === undefined ? null : failed[2];
}

function pathProblem(entry: unknown): string | null {
  if (!isRecord(entry) || !isText(entry.path))
    return "a path entry has no path";
  const problem = firstProblem(entry, PATH_CHECKS);
  return problem === null ? null : `${entry.path}: ${problem}`;
}

function reportProblem(value: unknown): string | null {
  if (!isRecord(value)) return "not a JSON object";
  const problem = firstProblem(value, REPORT_CHECKS);
  if (problem !== null) return problem;
  for (const entry of value.paths as unknown[]) {
    const pathFault = pathProblem(entry);
    if (pathFault !== null) return pathFault;
  }
  return null;
}

function parsedFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw badReport(
      file,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Read and check the report; throws naming what is wrong. */
export function readHotspotReport(file: string): HotspotReport {
  const value = parsedFile(file);
  const problem = reportProblem(value);
  if (problem !== null) throw badReport(file, problem);
  const report = value as unknown as Report;
  const byPath = new Map(report.paths.map((entry) => [entry.path, entry]));
  const skipped: Record<string, number> = {};
  for (const { reason } of report.skipped)
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  return {
    range: { since: report.range.since, label: report.range.label },
    hotspotMinMerges: report.hotspotMinMerges,
    shallow: report.shallow === true,
    totalMerges: report.totals.merges,
    hotspots: (report.hotspots as unknown[]).map((path) => {
      const entry = typeof path === "string" ? byPath.get(path) : undefined;
      if (entry === undefined)
        throw badReport(file, `hotspot ${String(path)} has no path entry`);
      // A hotspot is a path that conflicted in at least the threshold's merges.
      if (
        entry.merges < report.hotspotMinMerges ||
        entry.merges > report.totals.merges
      )
        throw badReport(
          file,
          `hotspot ${entry.path} conflicted in ${entry.merges} merges, outside ${report.hotspotMinMerges} to ${report.totals.merges}`,
        );
      return entry;
    }),
    skipped,
    accuracy: report.confidence?.causes ?? null,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What the measurement could not see, for the finding to carry. */
function coverage(report: HotspotReport, cause: Cause): string[] {
  const skipped = Object.entries(report.skipped);
  const total = skipped.reduce((sum, [, n]) => sum + n, 0);
  const accuracy = report.accuracy?.[cause];
  return [
    ...(report.shallow
      ? [
          "The clone was shallow, so merges its boundary cuts were skipped and the count may be low.",
        ]
      : []),
    ...(total > 0
      ? [
          `${plural(total, "merge")} in the range could not be replayed (${skipped.map(([reason, n]) => `${reason} ${n}`).join(", ")}), so the count may be low.`,
        ]
      : []),
    accuracy === undefined
      ? `No hand-check of the ${cause} cause is recorded.`
      : `A hand-check found the ${cause} cause right in ${accuracy.correct} of ${accuracy.checked} regions.`,
    "The report counts only the merge commits this clone's refs reach; its limits section says what else it cannot see.",
  ];
}

function causeCounts(summary: PathSummary): string {
  return CAUSES.filter((cause) => (summary.causes[cause] ?? 0) > 0)
    .map((cause) => `${cause} ${summary.causes[cause]}`)
    .join(", ");
}

/** The finding a hotspot becomes, as a note for the journal. */
export function hotspotNote(
  report: HotspotReport,
  summary: PathSummary,
): FindingNote {
  const cause = summary.topCause;
  const merges = plural(summary.merges, "merge");
  const description = [
    `${summary.path} conflicted in ${merges} of the ${report.totalMerges} replayed over ${report.range.label}, most recently on ${summary.lastConflict.slice(0, 10)}; a path that conflicts in ${report.hotspotMinMerges} or more is a conflict hotspot.`,
    `Its most frequent cause is ${cause}: ${SHAPES[cause]}`,
    `Conflicting regions by cause: ${causeCounts(summary)}.`,
    "Measured by the history report of resolve-conflicts (history.ts).",
    ...coverage(report, cause),
  ].join(" ");
  return {
    kind: "error",
    severity: summary.merges >= report.hotspotMinMerges * 2 ? "high" : "medium",
    class: cause,
    target: { scope: "repository", name: summary.path },
    title: `${summary.path} conflicted in ${merges} (${cause})`,
    description,
    suggested_fix: summary.remedy,
    // The finding is about the repository's history, not this branch.
    change: { branch: null, pull_request: null, issue: null },
  };
}

function sameHotspot(
  finding: FindingEvent,
  owner: string,
  path: string,
  cause: Cause,
): boolean {
  return (
    ownerOf(finding) === owner &&
    finding.class === cause &&
    finding.target.scope === "repository" &&
    finding.target.name === path
  );
}

/**
 * The stored finding that already records this hotspot, or null when a new
 * one is due: none is stored, or each was implemented before the report's
 * range began, so every merge measured came after the fix.
 */
function storedFinding(
  state: ComputedState,
  owner: string,
  summary: PathSummary,
  since: string | null,
): FindingState | null {
  const held = [...state.findings.values()].filter((entry) =>
    sameHotspot(entry.finding, owner, summary.path, summary.topCause),
  );
  const recurredAfterFix = (entry: FindingState) =>
    entry.status === "implemented" &&
    since !== null &&
    entry.latest !== null &&
    Date.parse(entry.latest.at) < Date.parse(since);
  return held.find((entry) => !recurredAfterFix(entry)) ?? null;
}

export interface HotspotResult {
  path: string;
  class: Cause;
  merges: number;
  /**
   * noted: a new finding in the journal; updated: the journal's finding
   * revised to this measurement; unchanged: the journal already holds it as
   * measured; sending: a cut-off send may have stored it, so it is left;
   * stored: the store already records it.
   */
  action: "noted" | "updated" | "unchanged" | "sending" | "stored";
  id: string;
  /** For `stored`, the stored finding's status. */
  status?: string;
}

const COMPARED = ["severity", "title", "description", "suggested_fix"] as const;

/** Note, revise or leave one hotspot's finding. */
function recordHotspot(
  journal: string,
  report: HotspotReport,
  summary: PathSummary,
  state: ComputedState,
  scriptDir: string,
): HotspotResult {
  const result = {
    path: summary.path,
    class: summary.topCause,
    merges: summary.merges,
  };
  const note = hotspotNote(report, summary);
  const finding = buildFinding(note, {
    scriptDir,
    skill: "resolve-conflicts",
  });
  const owner = ownerOf(finding);
  const held = readJournal(journal);
  const waiting = unsent(held).find((entry) =>
    sameHotspot(entry, owner, summary.path, summary.topCause),
  );
  if (waiting !== undefined) {
    if (held.sending.has(waiting.id))
      return { ...result, action: "sending", id: waiting.id };
    if (COMPARED.every((field) => waiting[field] === finding[field]))
      return { ...result, action: "unchanged", id: waiting.id };
    const patch = Object.fromEntries(
      COMPARED.map((field) => [field, finding[field]]),
    );
    reviseFinding(journal, waiting.id, patch);
    return { ...result, action: "updated", id: waiting.id };
  }
  const stored = storedFinding(state, owner, summary, report.range.since);
  if (stored !== null)
    return {
      ...result,
      action: "stored",
      id: stored.finding.id,
      status: stored.status,
    };
  noteFinding(journal, finding);
  return { ...result, action: "noted", id: finding.id };
}

/** Record every hotspot of the report; one result per hotspot, in report order. */
export function recordHotspots(
  journal: string,
  report: HotspotReport,
  state: ComputedState,
  scriptDir: string,
): HotspotResult[] {
  return report.hotspots.map((summary) =>
    recordHotspot(journal, report, summary, state, scriptDir),
  );
}
