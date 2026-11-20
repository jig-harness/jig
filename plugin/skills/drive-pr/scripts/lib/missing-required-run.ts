/**
 * A required check whose workflow never ran on the head. The CI hold waits
 * for the head's required checks to complete before it takes the hold; a
 * check that has no run at all (an event or path filter that excluded the
 * head, a workflow that failed to start) never completes, so the hold would
 * wait for a run nobody requested. These predicates tell a check that has a
 * run, queued, running or completed, from one that has none, after a bounded
 * grace from the head's push and a settle window after its last workflow run
 * finished (a service that reports a check once the workflows end posts it
 * then), and name the workflow when the repository's workflow files identify
 * it. A head nothing has run on yet waits: that is CI not started, which a
 * person cannot repair in the workflow.
 */

import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { load } from "../../../../shared/yaml.ts";
import { parseMs } from "../../../../shared/time.ts";
import type { CheckRunLite, StatusLite } from "./ci-hold.ts";
import type { WorkflowRun } from "./status/workflow-runs.ts";

/** How long after the head's push a required check may still have no run. */
export const MISSING_RUN_GRACE_MS = 15 * 60_000;

/** How long after the head's last workflow run finished a required check may still have no run. */
export const MISSING_RUN_SETTLE_MS = 5 * 60_000;

/** The parked finding a missing required run stops the drive under. */
export const MISSING_RUN_PARK_KEY = "missing-required-run";

/** What the head's runs say of the required checks that have none. */
export type MissingRunVerdict =
  | { kind: "none" }
  | { kind: "wait"; checks: string[]; reason: string }
  | { kind: "missing"; checks: string[] };

export interface MissingRunInput {
  /** The check runs on the head. */
  runs: readonly CheckRunLite[];
  /** The head's commit statuses: a required context may be met by one. */
  statuses: readonly StatusLite[];
  /** The workflow runs on the head. */
  workflowRuns: readonly WorkflowRun[];
  required: readonly string[];
  head: string;
  nowMs: number;
  graceMs: number;
  settleMs: number;
}

/** The required checks with neither a check run nor a commit status on `head`. */
export function requiredWithoutAnyRun(
  runs: readonly CheckRunLite[],
  statuses: readonly StatusLite[],
  required: readonly string[],
  head: string,
): string[] {
  return required.filter(
    (name) =>
      !runs.some((run) => run.headSha === head && run.name === name) &&
      !statuses.some(
        (status) => status.context.toLowerCase() === name.toLowerCase(),
      ),
  );
}

/**
 * When the head was pushed, as its runs show it: the earliest workflow run
 * created or check run started on it, since GitHub creates them on the push;
 * `null` when nothing has run on it.
 */
export function headPushedMs(
  runs: readonly CheckRunLite[],
  workflowRuns: readonly WorkflowRun[],
  head: string,
): number | null {
  const moments = [
    ...workflowRuns.map((run) => parseMs(run.createdAt)),
    ...runs
      .filter((run) => run.headSha === head && run.startedAt !== null)
      .map((run) => parseMs(run.startedAt as string)),
  ].filter(Number.isFinite);
  return moments.length > 0 ? Math.min(...moments) : null;
}

/** When the head's last workflow run finished, as far as its runs show; `null` with none. */
export function lastWorkflowFinishedMs(
  workflowRuns: readonly WorkflowRun[],
): number | null {
  const moments = workflowRuns
    .map((run) => parseMs(run.updatedAt ?? run.startedAt))
    .filter(Number.isFinite);
  return moments.length > 0 ? Math.max(...moments) : null;
}

const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/**
 * Whether the required checks with no run on the head are missing: none of
 * the head's workflow runs is still to finish (a queued or running workflow
 * may yet report the check), the grace from the head's push is spent, and so
 * is the settle window after its last workflow run finished.
 */
export function missingRequiredRuns(input: MissingRunInput): MissingRunVerdict {
  const checks = requiredWithoutAnyRun(
    input.runs,
    input.statuses,
    input.required,
    input.head,
  );
  if (checks.length === 0) return { kind: "none" };
  if (input.workflowRuns.some((run) => run.status !== "completed"))
    return {
      kind: "wait",
      checks,
      reason: "a workflow run on the head has not finished and may report it",
    };
  const pushedMs = headPushedMs(input.runs, input.workflowRuns, input.head);
  if (pushedMs === null)
    return {
      kind: "wait",
      checks,
      reason: "nothing has run on the head yet",
    };
  const waited = input.nowMs - pushedMs;
  if (waited < input.graceMs)
    return {
      kind: "wait",
      checks,
      reason: `the head was pushed ${seconds(waited)}s ago, within the ${seconds(input.graceMs)}s grace`,
    };
  const finishedMs = lastWorkflowFinishedMs(input.workflowRuns);
  const settled = finishedMs === null ? null : input.nowMs - finishedMs;
  if (settled !== null && settled < input.settleMs)
    return {
      kind: "wait",
      checks,
      reason: `the head's last workflow run finished ${seconds(settled)}s ago, within the ${seconds(input.settleMs)}s a service reporting after it may take`,
    };
  return { kind: "missing", checks };
}

/** A workflow file as the repository holds it. */
export interface WorkflowFile {
  /** Its path from the repository's root. */
  path: string;
  text: string;
}

const isPlain = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** The job's matrix when it lists plain values without excluding combinations. */
function matrixGrid(job: unknown): Record<string, unknown> | null {
  const strategy = isRecord(job) ? job.strategy : undefined;
  const matrix = isRecord(strategy) ? strategy.matrix : undefined;
  return isRecord(matrix) && !("exclude" in matrix) ? matrix : null;
}

/** The values a job's matrix gives `key`, when they are plain listed values; `null` when they cannot be told. */
function matrixValues(job: unknown, key: string): string[] | null {
  const grid = matrixGrid(job);
  if (grid === null) return null;
  const listed = grid[key];
  if (key in grid && !Array.isArray(listed)) return null;
  const included = Array.isArray(grid.include)
    ? grid.include.flatMap((e: unknown) =>
        isRecord(e) && key in e ? [e[key]] : [],
      )
    : [];
  const values = [...(Array.isArray(listed) ? listed : []), ...included];
  return values.length > 0 && values.every(isPlain) ? values.map(String) : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The check names a job may report: its `name`, else its id; a templated
 * name as a pattern over the values its matrix lists. A name whose
 * name is not exactly one plain reference to a matrix key's listed values (a second expression, even of the same key, would pair values no job reports), or
 * whose matrix excludes combinations, is left unattributed rather than matched by its fixed prefix.
 */
function jobNames(
  id: string,
  job: unknown,
): { exact: string[]; pattern: RegExp[] } {
  const name = isRecord(job) ? job.name : undefined;
  if (typeof name !== "string") return { exact: [id], pattern: [] };
  if (!name.includes("${{")) return { exact: [name], pattern: [] };
  const pattern = templatedPattern(name, job);
  return { exact: [], pattern: pattern === null ? [] : [pattern] };
}

/** The pattern a templated job name matches, or `null` when it is not one plain matrix reference. */
function templatedPattern(name: string, job: unknown): RegExp | null {
  const expressions = [...name.matchAll(/\$\{\{([\s\S]*?)\}\}/g)];
  if (expressions.length > 1) return null;
  let source = "";
  let last = 0;
  for (const m of expressions) {
    const key = /^\s*matrix\.([A-Za-z_][\w-]*)\s*$/.exec(m[1] ?? "")?.[1];
    const values = key === undefined ? null : matrixValues(job, key);
    if (values === null) return null;
    source += `${escapeRegExp(name.slice(last, m.index))}(?:${values.map(escapeRegExp).join("|")})`;
    last = m.index + m[0].length;
  }
  source += escapeRegExp(name.slice(last));
  return new RegExp(`^${source}(?: \\([\\s\\S]*| / [\\s\\S]*)?$`);
}

/**
 * Whether a job named `name` reports `check`: the same name, a matrix job's
 * `name (values)`, or a reusable workflow's `name / job`.
 */
function reports(check: string, name: string): boolean {
  return (
    check === name ||
    check.startsWith(`${name} (`) ||
    check.startsWith(`${name} / `)
  );
}

/**
 * The workflow file that defines the job reporting `check`, when exactly one
 * does; `null` when none does, several do, or no file reads.
 */
export function workflowForCheck(
  check: string,
  files: readonly WorkflowFile[],
): string | null {
  const matches = files
    .filter((file) => fileReports(check, file))
    .map((file) => file.path);
  return new Set(matches).size === 1 ? (matches[0] ?? null) : null;
}

/** Whether any job of the workflow file reports `check`; a file that does not read as YAML reports nothing. */
function fileReports(check: string, file: WorkflowFile): boolean {
  let doc: unknown;
  try {
    doc = load(file.text);
  } catch (err) {
    swallow(err, `the workflow file ${file.path} does not read as YAML`);
    return false;
  }
  const jobs = isRecord(doc) ? doc.jobs : undefined;
  if (!isRecord(jobs)) return false;
  return Object.entries(jobs).some(([id, job]) => {
    const { exact, pattern } = jobNames(id, job);
    return (
      exact.some((name) => reports(check, name)) ||
      pattern.some((re) => re.test(check))
    );
  });
}

/** One missing check as the stop names it, its workflow `unknown` when no file identifies it. */
export function describeMissing(
  check: string,
  workflow: string | null,
): string {
  return `'${check}' (workflow: ${workflow ?? "unknown"})`;
}

/** The outcomes of `ci-hold.ts ensure` after which the push goes ahead with no hold to roll back. */
const UNHELD_OUTCOMES: readonly string[] = [
  "disabled",
  "conflicting",
  "workflow-change",
  "timed-out",
  "adopted",
];

/** Whether `ensure`'s stdout names an outcome that pushes unheld. */
export function isUnheldOutcome(stdout: string): boolean {
  return UNHELD_OUTCOMES.includes(stdout.trim());
}

/** Why `finish-round.ts` stops on a park `ensure` made, by what `ensure` printed. */
export function holdParkReason(stdout: string): string {
  return stdout.trim() === MISSING_RUN_PARK_KEY
    ? `a required check has no run on the PR head past the grace after its push; see the ${MISSING_RUN_PARK_KEY} parked finding for the check and its workflow`
    : "cancelled CI needs a person; see the cancelled-ci parked finding for the run and recovery";
}
