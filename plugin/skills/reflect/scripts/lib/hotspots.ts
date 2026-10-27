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

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** A field, the check its value must pass, and what to say when it fails. */
type Check = [field: string, ok: (value: unknown) => boolean, problem: string];

const REPORT_CHECKS: readonly Check[] = [
  ["schema", (value) => value === SCHEMA, `its schema is not ${SCHEMA}`],
  [
    "range",
    (value) => isRecord(value) && typeof value.label === "string",
    "range is missing",
  ],
  [
    "totals",
    (value) => isRecord(value) && Number.isSafeInteger(value.merges),
    "totals is missing",
  ],
  ["hotspotMinMerges", isCount, "hotspotMinMerges is missing"],
  ["paths", Array.isArray, "paths is missing"],
  ["hotspots", Array.isArray, "hotspots is missing"],
];

const PATH_CHECKS: readonly Check[] = [
  ["merges", isCount, "merges is not a count"],
  ["topCause", isCause, "topCause is not a cause"],
  ["remedy", isText, "remedy is missing"],
  ["causes", isRecord, "causes is missing"],
  ["lastConflict", isText, "lastConflict is missing"],
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
  return {
    range: {
      since: typeof report.range.since === "string" ? report.range.since : null,
      label: report.range.label,
    },
    hotspotMinMerges: report.hotspotMinMerges,
    shallow: report.shallow === true,
    totalMerges: report.totals.merges,
    hotspots: (report.hotspots as unknown[]).map((path) => {
      const entry = typeof path === "string" ? byPath.get(path) : undefined;
      if (entry === undefined)
        throw badReport(file, `hotspot ${String(path)} has no path entry`);
      return entry;
    }),
  };
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
  const merges = `${summary.merges} merge${summary.merges === 1 ? "" : "s"}`;
  const description = [
    `${summary.path} conflicted in ${merges} of the ${report.totalMerges} replayed over ${report.range.label}, most recently on ${summary.lastConflict.slice(0, 10)}; a path that conflicts in ${report.hotspotMinMerges} or more is a conflict hotspot.`,
    `Its most frequent cause is ${cause}: ${SHAPES[cause]}`,
    `Conflicting regions by cause: ${causeCounts(summary)}.`,
    "Measured by the history report of resolve-conflicts (history.ts).",
    ...(report.shallow
      ? [
          "The clone was shallow, so merges its boundary cuts were skipped and the count may be low.",
        ]
      : []),
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
    Date.parse(entry.latest.at) <= Date.parse(since);
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
