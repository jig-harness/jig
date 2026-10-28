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
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../../../shared/guards.ts";
import {
  CAUSES,
  type Cause,
  SHAPES,
} from "../../../resolve-conflicts/scripts/lib/causes.ts";
import {
  type Accuracy,
  buildReport,
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
  totalMerges: number;
  /** What the replay cannot see, as the report states it. */
  limits: string[];
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

/** An ISO 8601 time with its offset, as git's `%cI` writes a committer date. */
const OFFSET_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    OFFSET_TIME.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** A range end as the report writes it: UTC, through `toISOString()`. */
function isRangeEnd(value: unknown): boolean {
  return (
    value === null ||
    (isTime(value) && new Date(Date.parse(value)).toISOString() === value)
  );
}

function isCauseList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isCause);
}

/** What `buildReport` reads of a conflicted path: its name and its causes. */
function isPathRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.path) &&
    isCauseList(value.causes) &&
    Array.isArray(value.regions) &&
    value.regions.every((region) => isRecord(region) && isCause(region.cause))
  );
}

/** What `buildReport` reads of a replayed merge. */
function isMergeRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.commit) &&
    isTime(value.date) &&
    typeof value.conflicted === "boolean" &&
    (value.mechanical === null || typeof value.mechanical === "boolean") &&
    Array.isArray(value.paths) &&
    value.paths.every(isPathRecord)
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

/** A range's ends: each null (open) or a UTC time, the start before the end. */
function isRange(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    !isRangeEnd(value.since) ||
    !isRangeEnd(value.until)
  )
    return false;
  return (
    value.since === null ||
    value.until === null ||
    Date.parse(value.since as string) < Date.parse(value.until as string)
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
    isRange,
    "range is missing, its since or until is not a date, or it ends before it starts",
  ],
  [
    "totals",
    (value) => isRecord(value) && isWhole(value.merges),
    "totals.merges is not a count",
  ],
  ["hotspotMinMerges", isCount, "hotspotMinMerges is missing"],
  ["shallow", (value) => typeof value === "boolean", "shallow is missing"],
  [
    "merges",
    (value) => Array.isArray(value) && value.every(isMergeRecord),
    "merges is not a list of replayed merges, each dated with its offset",
  ],
  ["paths", Array.isArray, "paths is missing"],
  ["hotspots", Array.isArray, "hotspots is missing"],
  ["skipped", isSkipped, "skipped is not a list of skipped merges"],
  ["confidence", isConfidence, "confidence is not a hand-check"],
  ["limits", Array.isArray, "limits is missing"],
];

function firstProblem(
  value: Record<string, unknown>,
  checks: readonly Check[],
): string | null {
  const failed = checks.find(([field, ok]) => !ok(value[field]));
  return failed === undefined ? null : failed[2];
}

function byPath<T extends { path: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

function sorted(values: readonly unknown[]): unknown[] {
  return [...values].sort((a, b) =>
    String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
  );
}

/**
 * Every value the history report derives from the merges it replayed, checked
 * by deriving it again with the report's own `buildReport`: each merge lies in
 * the range, and the totals, the paths, the hotspots and the limits are the
 * ones those merges give, each path and hotspot once. Order is not compared,
 * since the report sorts paths by the producer's locale. A report written by
 * another version of `history.ts` can differ in wording and is refused;
 * measuring again gives one this version accepts.
 */
function derivedProblem(report: Report): string | null {
  const { since, until } = report.range;
  const outside = report.merges.find(
    ({ date }) =>
      (since !== null && Date.parse(date) < Date.parse(since)) ||
      (until !== null && Date.parse(date) >= Date.parse(until)),
  );
  if (outside !== undefined)
    return `merge ${outside.commit} is outside the range`;
  const derived = buildReport(report);
  const mismatched: Array<[string, unknown, unknown]> = [
    ["totals", report.totals, derived.totals],
    ["paths", byPath(report.paths), byPath(derived.paths)],
    ["hotspots", sorted(report.hotspots), sorted(derived.hotspots)],
    ["limits", report.limits, derived.limits],
  ];
  const wrong = mismatched.find(
    ([, given, expected]) => !isDeepStrictEqual(given, expected),
  );
  return wrong === undefined
    ? null
    : `its ${wrong[0]} are not what its merges give`;
}

function reportProblem(value: unknown): string | null {
  if (!isRecord(value)) return "not a JSON object";
  return (
    firstProblem(value, REPORT_CHECKS) ??
    derivedProblem(value as unknown as Report)
  );
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
  const summaries = new Map(report.paths.map((entry) => [entry.path, entry]));
  const skipped: Record<string, number> = {};
  for (const { reason } of report.skipped)
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  return {
    range: { since: report.range.since, label: report.range.label },
    hotspotMinMerges: report.hotspotMinMerges,
    totalMerges: report.totals.merges,
    limits: report.limits,
    hotspots: report.hotspots.map((path) => summaries.get(path) as PathSummary),
    skipped,
    accuracy: report.confidence?.causes ?? null,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * What the measurement could not see, for the finding to carry: the report's
 * own limits travel whole, since the finding outlives the report file.
 */
function coverage(report: HotspotReport, cause: Cause): string[] {
  const skipped = Object.entries(report.skipped);
  const total = skipped.reduce((sum, [, n]) => sum + n, 0);
  const accuracy = report.accuracy?.[cause];
  return [
    ...(total > 0
      ? [
          `${plural(total, "merge")} in the range could not be replayed (${skipped.map(([reason, n]) => `${reason} ${n}`).join(", ")}), so the count may be low.`,
        ]
      : []),
    accuracy === undefined
      ? `No hand-check of the ${cause} cause is recorded.`
      : `A hand-check found the ${cause} cause right in ${accuracy.correct} of ${accuracy.checked} regions.`,
    ...(report.limits.length > 0
      ? [`What the report cannot see: ${report.limits.join(" ")}`]
      : []),
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
