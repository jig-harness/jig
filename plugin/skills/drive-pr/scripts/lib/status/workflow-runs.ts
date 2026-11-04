/**
 * The workflow runs behind a head's check runs. A check run reports one job;
 * cancelled checks are an absence of evidence: never a failure to repair and
 * never a pass. Every other unsuccessful job remains a failure, even in a
 * cancelled run, until a later completed run replaces that run.
 *
 * The check suite id links the two: every job of a run carries it, and the
 * jobs on a head's check-run list are the run's jobs, so reading them costs no
 * call per run. No reading here looks at a run's event: a head can carry
 * `pull_request` and `workflow_dispatch` runs of one workflow side by side.
 */

import { swallow } from "../../../../../shared/errors.ts";
import { ghCall } from "../proc.ts";

export const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * A conclusion that reports what the code did. Everything else leaves the
 * question open: `skipped` says nothing ran, `cancelled` that it stopped, and
 * `startup_failure`, `action_required` and `stale` that it never got going.
 */
const RESULT_CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "timed_out",
]);

export interface WorkflowRun {
  id: number;
  workflowId: number;
  status: string;
  conclusion: string | null;
  checkSuiteId: number;
  /** When the run was created; a re-run replays the event of this moment. */
  createdAt: string;
  /** When its latest attempt started; a re-run moves this, not `createdAt`. */
  startedAt: string;
  /** Which attempt this is; a re-run raises it. */
  attempt: number;
}

/** What a check run has to say for its run to be read. */
export interface JobEvidence {
  /** The check's name; absent when the reading does not need it. */
  name?: string;
  status: string;
  conclusion: string | null;
  /** The check suite of the run it belongs to; absent when it names none. */
  suiteId?: number | null;
}

/**
 * A failed run a repair pass is told about. `createdAt` says whether the CI
 * hold's label was on when it was created, which a re-run would replay.
 */
export interface FailedRun {
  id: number;
  createdAt: string;
}

function parseWorkflowRun(raw: unknown): WorkflowRun | null {
  if (typeof raw !== "object" || raw === null) return null;
  const run = raw as Record<string, unknown>;
  const { id, workflow_id: workflowId, status, conclusion } = run;
  const { check_suite_id: checkSuiteId, created_at: createdAt } = run;
  if (
    typeof id !== "number" ||
    typeof workflowId !== "number" ||
    typeof status !== "string" ||
    (conclusion !== null && typeof conclusion !== "string") ||
    typeof checkSuiteId !== "number" ||
    typeof createdAt !== "string"
  )
    return null;
  const startedAt =
    typeof run.run_started_at === "string" ? run.run_started_at : createdAt;
  return {
    id,
    workflowId,
    status,
    conclusion,
    checkSuiteId,
    createdAt,
    startedAt,
    attempt: typeof run.run_attempt === "number" ? run.run_attempt : 1,
  };
}

/** Every workflow run on `sha`, or `null` when they cannot be read. */
export async function workflowRunsFor(
  owner: string,
  repo: string,
  sha: string,
): Promise<WorkflowRun[] | null> {
  const r = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
  ]);
  if (r.code !== 0) return null;
  try {
    const pages: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(pages)) return null;
    const runs: WorkflowRun[] = [];
    for (const page of pages) {
      const list = (page as { workflow_runs?: unknown } | null)?.workflow_runs;
      if (!Array.isArray(list)) return null;
      for (const raw of list) {
        const run = parseWorkflowRun(raw);
        if (run === null) return null;
        runs.push(run);
      }
    }
    return runs;
  } catch (err) {
    swallow(err, "the workflow runs are not JSON: read as unreadable");
    return null;
  }
}

/**
 * The workflow runs a reading of `jobs` needs. Only a job that completed and
 * did not pass has anything to explain, so a healthy head spends no call on
 * them. `null` when they cannot be read: every reading below then treats the
 * check runs on their own, which keeps a cancelled check unknown and a failed
 * one failing.
 */
export async function workflowRunsBehind(
  owner: string,
  repo: string,
  sha: string,
  jobs: readonly JobEvidence[],
): Promise<WorkflowRun[] | null> {
  const toExplain = jobs.some(
    (job) =>
      job.status === "completed" &&
      job.conclusion !== null &&
      !PASSING_CONCLUSIONS.has(job.conclusion),
  );
  return toExplain ? workflowRunsFor(owner, repo, sha) : [];
}

function hasResult(run: WorkflowRun, jobs: readonly JobEvidence[]): boolean {
  return (
    run.status === "completed" &&
    run.conclusion !== null &&
    RESULT_CONCLUSIONS.has(run.conclusion) &&
    jobs.some(
      (job) =>
        job.suiteId === run.checkSuiteId &&
        job.status === "completed" &&
        job.conclusion !== null &&
        RESULT_CONCLUSIONS.has(job.conclusion),
    )
  );
}

/**
 * The cancelled runs another run has replaced: a run of the same workflow on
 * this head, started no earlier, has completed with a result of its own.
 *
 * Started no earlier, because a passing run from BEFORE the cancellation says
 * nothing about it: that is the head of a CI hold, whose held run cancels
 * itself so that the required check blocks the merge beside the opening run's
 * green. Compared by start time rather than run id, because a concurrency
 * group can cancel the higher id in favour of a lower one started in the same
 * second, and the times have one-second precision. And the replacing run must
 * show a job that ran: a run that skipped everything, or never started any,
 * has not looked at the code.
 */
function replacedSuites(
  jobs: readonly JobEvidence[],
  workflowRuns: readonly WorkflowRun[],
): Map<number, number[]> {
  const replaced = new Map<number, number[]>();
  for (const run of workflowRuns) {
    if (run.status !== "completed" || run.conclusion !== "cancelled") continue;
    const started = Date.parse(run.startedAt);
    const successors = workflowRuns.filter(
      (other) =>
        other.id !== run.id &&
        other.workflowId === run.workflowId &&
        Date.parse(other.startedAt) >= started &&
        hasResult(other, jobs),
    );
    if (successors.length > 0)
      replaced.set(
        run.checkSuiteId,
        successors.map((other) => other.checkSuiteId),
      );
  }
  return replaced;
}

/**
 * Whether a replaced run's job stays as evidence. It goes only when a
 * successor reports its name with a result, or when no successor reports the
 * name at all (a matrix template the later run expanded). A successor that
 * reports the name without a result (it skipped) answers nothing, so the job
 * stays, unless another successor did supply one. Jobs that passed never stay.
 */
function answeredBySkip(
  job: JobEvidence,
  successors: readonly number[],
  jobs: readonly JobEvidence[],
): boolean {
  if (job.name === undefined) return false;
  if (job.conclusion !== null && PASSING_CONCLUSIONS.has(job.conclusion))
    return false;
  const reports = jobs.filter(
    (other) =>
      other.name === job.name &&
      other.suiteId !== undefined &&
      other.suiteId !== null &&
      successors.includes(other.suiteId),
  );
  const hasResultJob = reports.some(
    (other) =>
      other.status === "completed" &&
      other.conclusion !== null &&
      RESULT_CONCLUSIONS.has(other.conclusion),
  );
  return reports.length > 0 && !hasResultJob;
}

/**
 * `jobs` less those of a cancelled run another run has replaced, whatever the
 * name: a run cancelled before its matrix expanded leaves a check named after
 * the unexpanded template, which no later run ever reports under that name.
 * An unsuccessful job stays when the replacing runs report its name only as
 * skipped.
 */
export function withoutSuperseded<T extends JobEvidence>(
  jobs: readonly T[],
  workflowRuns: readonly WorkflowRun[] | null,
): T[] {
  if (workflowRuns === null) return [...jobs];
  const replaced = replacedSuites(jobs, workflowRuns);
  return jobs.filter((job) => {
    if (job.suiteId === undefined || job.suiteId === null) return true;
    const successors = replaced.get(job.suiteId);
    return successors === undefined || answeredBySkip(job, successors, jobs);
  });
}

/**
 * `jobs` less the unsuccessful ones of a run being re-run: the re-run replaces
 * them, so until it completes they witness nothing.
 */
export function withoutRerunning<T extends JobEvidence>(
  jobs: readonly T[],
  workflowRuns: readonly WorkflowRun[] | null,
): T[] {
  const rerunning = rerunningSuites(workflowRuns);
  return jobs.filter(
    (job) =>
      job.suiteId === undefined ||
      job.suiteId === null ||
      !rerunning.has(job.suiteId) ||
      (job.conclusion !== null && PASSING_CONCLUSIONS.has(job.conclusion)),
  );
}

/**
 * A run being re-run still owes every unsuccessful job's result until it
 * completes. Another run's success cannot discharge that obligation: run
 * timestamps do not date jobs retained from an earlier attempt.
 */
export function rerunAwaitsResult(
  jobs: readonly JobEvidence[],
  workflowRuns: readonly WorkflowRun[] | null,
): boolean {
  return unreplacedRerunJobs(jobs, workflowRuns).length > 0;
}

/** The unsuccessful jobs whose own workflow run is still being re-run. */
export function unreplacedRerunJobs<T extends JobEvidence>(
  jobs: readonly T[],
  workflowRuns: readonly WorkflowRun[] | null,
): T[] {
  const kept = new Set(withoutRerunning(jobs, workflowRuns));
  return jobs.filter((job) => !kept.has(job));
}

/**
 * The check suites of the runs being re-run. A job of one that did not pass may
 * be the previous attempt's, about to be replaced, so it is waited for: a pass
 * that just re-ran the run must not read as having changed nothing.
 */
export function rerunningSuites(
  workflowRuns: readonly WorkflowRun[] | null,
): Set<number> {
  return new Set(
    (workflowRuns ?? [])
      .filter((run) => run.status !== "completed" && run.attempt > 1)
      .map((run) => run.checkSuiteId),
  );
}

/**
 * The workflow runs the failing `jobs` belong to, once each, oldest first.
 * `null` when the runs could not be read; a job from a check that is not a
 * workflow's has no run to name.
 */
export function failedRunsOf(
  jobs: readonly JobEvidence[],
  workflowRuns: readonly WorkflowRun[] | null,
): FailedRun[] | null {
  if (workflowRuns === null) return null;
  const suites = new Set(jobs.map((job) => job.suiteId));
  return workflowRuns
    .filter((run) => suites.has(run.checkSuiteId))
    .sort((a, b) => a.id - b.id)
    .map((run) => ({ id: run.id, createdAt: run.createdAt }));
}
