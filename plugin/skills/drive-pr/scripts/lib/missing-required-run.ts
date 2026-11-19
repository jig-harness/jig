/**
 * A required check whose workflow never ran on the head. The CI hold waits
 * for the head's required checks to complete before it takes the hold; a
 * check that has no run at all (an event or path filter that excluded the
 * head, a workflow that failed to start) never completes, so the hold would
 * wait for a run nobody requested. These predicates tell a check that has a
 * run, queued, running or completed, from one that has none, after a bounded
 * grace from the head's push, and name the workflow when the repository's
 * workflow files identify it.
 */

import { swallow } from "../../../../shared/errors.ts";
import { load } from "../../../../shared/yaml.ts";
import { parseMs } from "../../../../shared/time.ts";
import type { CheckRunLite, StatusLite } from "./ci-hold.ts";
import type { WorkflowRun } from "./status/workflow-runs.ts";

/** How long after the head's push a required check may still have no run. */
export const MISSING_RUN_GRACE_MS = 15 * 60_000;

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
  /** When the head was pushed, as the evidence shows it; `null` when nothing shows it. */
  pushedMs: number | null;
  nowMs: number;
  graceMs: number;
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
 * created or check run started on it, since GitHub creates them on the push.
 * With none, `committedMs`, the head commit's committer date, which is no
 * later than its push; `null` when that is unknown too.
 */
export function headPushedMs(
  runs: readonly CheckRunLite[],
  workflowRuns: readonly WorkflowRun[],
  head: string,
  committedMs: number | null,
): number | null {
  const moments = [
    ...workflowRuns.map((run) => parseMs(run.createdAt)),
    ...runs
      .filter((run) => run.headSha === head && run.startedAt !== null)
      .map((run) => parseMs(run.startedAt as string)),
  ].filter(Number.isFinite);
  if (moments.length > 0) return Math.min(...moments);
  return committedMs !== null && Number.isFinite(committedMs)
    ? committedMs
    : null;
}

/**
 * Whether the required checks with no run on the head are missing: none of
 * the head's workflow runs is still to finish (a queued or running workflow
 * may yet report the check), and the grace from the head's push is spent.
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
  if (input.pushedMs === null)
    return {
      kind: "wait",
      checks,
      reason: "when the head was pushed cannot be read",
    };
  const waited = input.nowMs - input.pushedMs;
  if (waited < input.graceMs)
    return {
      kind: "wait",
      checks,
      reason: `the head was pushed ${Math.max(0, Math.round(waited / 1000))}s ago, within the ${Math.round(input.graceMs / 1000)}s grace`,
    };
  return { kind: "missing", checks };
}

/** A workflow file as the repository holds it. */
export interface WorkflowFile {
  /** Its path from the repository's root. */
  path: string;
  text: string;
}

/** The check names a job may report: its `name`, else its id; a templated name by its fixed prefix. */
function jobNames(
  id: string,
  job: unknown,
): { exact: string[]; prefix: string[] } {
  const name =
    typeof job === "object" && job !== null && !Array.isArray(job)
      ? (job as Record<string, unknown>).name
      : undefined;
  if (typeof name !== "string") return { exact: [id], prefix: [] };
  const template = name.indexOf("${{");
  if (template < 0) return { exact: [name], prefix: [] };
  const fixed = name.slice(0, template).trim();
  return { exact: [], prefix: fixed === "" ? [] : [fixed] };
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
  const matches = new Set<string>();
  for (const file of files) {
    let doc: unknown;
    try {
      doc = load(file.text);
    } catch (err) {
      swallow(err, `the workflow file ${file.path} does not read as YAML`);
      continue;
    }
    const jobs =
      typeof doc === "object" && doc !== null && !Array.isArray(doc)
        ? (doc as Record<string, unknown>).jobs
        : undefined;
    if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs))
      continue;
    for (const [id, job] of Object.entries(jobs)) {
      const { exact, prefix } = jobNames(id, job);
      if (
        exact.some((name) => reports(check, name)) ||
        prefix.some((fixed) => check.startsWith(fixed))
      )
        matches.add(file.path);
    }
  }
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}

/** One missing check as the stop names it, its workflow `unknown` when no file identifies it. */
export function describeMissing(
  check: string,
  workflow: string | null,
): string {
  return `'${check}' (workflow: ${workflow ?? "unknown"})`;
}
