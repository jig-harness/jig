/**
 * The workflow runs behind a head's check runs. A check run reports one job;
 * whether its conclusion says anything about the code depends on the run it
 * belongs to. A job of a cancelled run proves nothing, and neither does a
 * job that failed only because the jobs it needs were cancelled, so a
 * cancelled check is an absence of evidence: never a failure to repair, and
 * never a pass.
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

/** A job the timing of a cancellation can be read from. */
export interface TimedJob extends JobEvidence {
  id: number;
  started: string | null;
  completed?: string | null;
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
 * Whether a check name lost an unsuccessful job to a run being re-run and has
 * no success of its own left: the re-run's result is still owed, and a newer
 * skip of that name is not one. A success counts only from a later run than
 * the job it would replace: an older success predates the failure being re-run.
 */
export function rerunAwaitsResult<
  T extends JobEvidence & { appId?: number | null },
>(jobs: readonly T[], workflowRuns: readonly WorkflowRun[] | null): boolean {
  const kept = withoutRerunning(jobs, workflowRuns);
  return jobs
    .filter((job) => !kept.includes(job))
    .some(
      (job) =>
        !kept.some(
          (k) =>
            k.name === job.name &&
            k.appId === job.appId &&
            k.conclusion === "success" &&
            k.suiteId != null &&
            job.suiteId != null &&
            k.suiteId > job.suiteId,
        ),
    );
}

/**
 * The ids of the failed jobs that say nothing about the code: in a cancelled
 * run, an aggregator that `needs` cancelled jobs starts once they have ended
 * and fails on their result. A failed job counts only when it started after a
 * job of its run was cancelled, and only when every failed job of that run
 * did: one that started earlier failed on its own, so it is a real failure,
 * and an aggregator beside it failed for a real reason too. A job that may
 * have run beside another job of its run is not an aggregator. Nothing is
 * explained in a run that was not cancelled.
 */
export function failuresExplainedByCancellation(
  jobs: readonly TimedJob[],
  workflowRuns: readonly WorkflowRun[] | null,
): Set<number> {
  const explained = new Set<number>();
  for (const run of workflowRuns ?? []) {
    if (run.status !== "completed" || run.conclusion !== "cancelled") continue;
    const own = jobs.filter((job) => job.suiteId === run.checkSuiteId);
    const cancelledAt = own
      .filter((job) => job.conclusion === "cancelled")
      .map((job) => Date.parse(job.completed ?? ""))
      .filter((at) => Number.isFinite(at));
    if (cancelledAt.length === 0) continue;
    const firstCancelled = Math.min(...cancelledAt);
    const failed = own.filter(
      (job) =>
        job.status === "completed" &&
        job.conclusion !== null &&
        job.conclusion !== "cancelled" &&
        !PASSING_CONCLUSIONS.has(job.conclusion),
    );
    // Timing is the only evidence of a dependency, so it must leave no
    // doubt: the job started strictly after every other job of its run,
    // failed siblings included, had completed, as an aggregator over all of
    // them does. A job that could have run beside another stays a failure.
    const allAfter = failed.every((job) => {
      const startedAt = Date.parse(job.started ?? "");
      return (
        job.conclusion === "failure" &&
        startedAt > firstCancelled &&
        own
          .filter((other) => other.id !== job.id)
          .every((other) => Date.parse(other.completed ?? "") < startedAt)
      );
    });
    if (allAfter) for (const job of failed) explained.add(job.id);
  }
  return explained;
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
