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
import { failed, ok, type Outcome } from "../../../../../shared/outcome.ts";
import { forgeReadClass, type ForgeReadCode } from "../forge-read.ts";
import { type PagedRead, slurpPages } from "../paged-read.ts";
import { parseMs } from "../../../../../shared/time.ts";

export const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * A conclusion that reports what the code did. Everything else leaves the
 * question open: `skipped` says nothing ran, `cancelled` that it stopped, and
 * `startup_failure`, `action_required` and `stale` that it never got going.
 */
export const RESULT_CONCLUSIONS: ReadonlySet<string> = new Set([
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
  /** When the run last changed; for a completed run, about when it ended. */
  updatedAt?: string;
}

/** What a check run has to say for its run to be read. */
export interface JobEvidence {
  /** A newer attempt's check id, when available. */
  id?: number;
  /** Check-run start, in either reader's field spelling. */
  started?: string | null;
  startedAt?: string | null;
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
  /** Failing job names belonging to this run, linked through its check suite. */
  jobNames?: string[];
  id: number;
  createdAt: string;
  /** The run's own conclusion; `cancelled` says the run stopped before it finished. */
  conclusion?: string | null;
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
    ...(typeof run.updated_at === "string"
      ? { updatedAt: run.updated_at }
      : {}),
  };
}

/**
 * Every workflow run on `sha`, or how the read failed. `fresh` unless the
 * caller only observes (`paged-read.ts`): a CI-green proof, a hold release and
 * a re-run of cancelled jobs act on what GitHub says now.
 */
export async function readWorkflowRuns(
  owner: string,
  repo: string,
  sha: string,
  read: PagedRead = "fresh",
): Promise<Outcome<WorkflowRun[], ForgeReadCode>> {
  const r = await slurpPages(
    `repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
    read,
  );
  if (r.code !== 0)
    return failed(
      forgeReadClass(r),
      `gh api actions/runs exited ${r.code}: ${(r.stderrTail || r.stderr).trim().slice(-500)}`,
    );
  const malformed = failed(
    "malformed",
    "the workflow runs have an invalid shape",
  );
  try {
    const pages: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(pages)) return malformed;
    const runs: WorkflowRun[] = [];
    for (const page of pages) {
      const list = (page as { workflow_runs?: unknown } | null)?.workflow_runs;
      if (!Array.isArray(list)) return malformed;
      for (const raw of list) {
        const run = parseWorkflowRun(raw);
        if (run === null) return malformed;
        runs.push(run);
      }
    }
    return ok(runs);
  } catch (err) {
    swallow(err, "the workflow runs are not JSON: read as unreadable");
    return failed("malformed", "the workflow runs are not JSON");
  }
}

/** Every workflow run on `sha`, or `null` when they cannot be read. */
export async function workflowRunsFor(
  owner: string,
  repo: string,
  sha: string,
  read: PagedRead = "fresh",
): Promise<WorkflowRun[] | null> {
  const runs = await readWorkflowRuns(owner, repo, sha, read);
  return runs.ok ? runs.value : null;
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
  read: PagedRead = "fresh",
): Promise<WorkflowRun[] | null> {
  const toExplain = jobs.some(
    (job) =>
      job.status === "completed" &&
      job.conclusion !== null &&
      !PASSING_CONCLUSIONS.has(job.conclusion),
  );
  return toExplain ? workflowRunsFor(owner, repo, sha, read) : [];
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
    const started = parseMs(run.startedAt);
    const successors = workflowRuns.filter(
      (other) =>
        other.id !== run.id &&
        other.workflowId === run.workflowId &&
        parseMs(other.startedAt) >= started &&
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
 * name at all, nor any name of its matrix (a check the later run does not
 * have). A successor that reports the name without a result (it skipped)
 * answers nothing, so the job stays, unless another successor did supply one.
 * A successor that reports it only under its matrix's expanded names
 * (`tests (1/2)` for `tests`) answers it only when every one of them has a
 * result: a matrix whose legs were skipped, wholly or partly, has not run the
 * job. A separate job whose name merely extends this one's reads as a leg, so
 * the ambiguity keeps the check rather than passing it. Jobs that passed
 * never stay.
 */
function answeredBySkip(
  job: JobEvidence,
  successors: readonly number[],
  jobs: readonly JobEvidence[],
): boolean {
  if (job.name === undefined) return false;
  if (job.conclusion !== null && PASSING_CONCLUSIONS.has(job.conclusion))
    return false;
  const prefix = `${matrixTemplate(job.name)} (`;
  // Judged within each successor: one successor's skipped report must not hide
  // the completed legs another successor ran.
  let reported = false;
  for (const suite of successors) {
    const named = jobs.filter(
      (other) => other.name !== undefined && other.suiteId === suite,
    );
    const exact = named.filter((other) => other.name === job.name);
    const reports =
      exact.length > 0
        ? exact
        : named.filter((other) => other.name?.startsWith(prefix) === true);
    if (reports.length === 0) continue;
    reported = true;
    // Reports sharing a name are separate legs (a matrix axis the name omits),
    // so every one of them needs a result, not any one.
    const complete = reports.every(
      (other) =>
        other.status === "completed" &&
        other.conclusion !== null &&
        RESULT_CONCLUSIONS.has(other.conclusion),
    );
    if (complete) return false;
  }
  return reported;
}

/**
 * The name a job's matrix legs extend with ` (<leg>)`: the job's own name, or,
 * for a template cancelled before its matrix expanded, that name less its
 * last parenthesised suffix, the one still holding a `${{ … }}` expression.
 */
function matrixTemplate(name: string): string {
  const leg = lastLegStart(name);
  return leg !== -1 && name.slice(leg).includes("${{")
    ? name.slice(0, leg)
    : name;
}

/**
 * The last top-level ` (` outside every `${{ … }}` expression, or -1: a
 * parenthesis nested inside a suffix does not start a new one, so the suffix
 * enclosing a nested literal group is the one found.
 */
function lastLegStart(name: string): number {
  let last = -1;
  let depth = 0;
  for (let i = 0; i < name.length; i++) {
    if (name.startsWith("${{", i)) {
      const end = expressionEnd(name, i + 3);
      if (end === -1) break;
      i = end + 1;
    } else if (name[i] === "(") {
      if (depth === 0 && name[i - 1] === " ") last = i - 1;
      depth++;
    } else if (name[i] === ")") depth = Math.max(0, depth - 1);
  }
  return last;
}

/** The first expression terminator outside a GitHub-expression string literal. */
function expressionEnd(name: string, from: number): number {
  let quoted = false;
  for (let i = from; i < name.length; i++) {
    if (name[i] === "'") {
      if (quoted && name[i + 1] === "'") {
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && name.startsWith("}}", i)) {
      return i;
    }
  }
  return -1;
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
  const current = jobs.filter(
    (job) => !replacedAttempt(job, jobs, workflowRuns),
  );
  const replaced = replacedSuites(current, workflowRuns);
  return current.filter((job) => {
    if (job.suiteId === undefined || job.suiteId === null) return true;
    const successors = replaced.get(job.suiteId);
    return successors === undefined || answeredBySkip(job, successors, current);
  });
}

/** A completed later attempt can expand a matrix without retaining its template name. */
function replacedAttempt(
  job: JobEvidence,
  jobs: readonly JobEvidence[],
  runs: readonly WorkflowRun[],
): boolean {
  if (job.conclusion !== "cancelled") return false;
  const run = runs.find((run) => run.checkSuiteId === job.suiteId);
  if (
    run === undefined ||
    run.attempt <= 1 ||
    run.status !== "completed" ||
    run.conclusion === null ||
    !RESULT_CONCLUSIONS.has(run.conclusion)
  )
    return false;
  const floor = parseMs(run.startedAt);
  const started = parseMs(job.started ?? job.startedAt ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(floor) || started >= floor)
    return false;
  const latest = jobs.filter(
    (other) =>
      other.suiteId === job.suiteId &&
      parseMs(other.started ?? other.startedAt ?? "") >= floor,
  );
  return (
    hasResult(run, latest) && !answeredBySkip(job, [run.checkSuiteId], latest)
  );
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
    .map((run) => ({
      id: run.id,
      createdAt: run.createdAt,
      conclusion: run.conclusion,
      jobNames: jobs
        .filter((job) => job.suiteId === run.checkSuiteId)
        .map((job) => job.name ?? ""),
    }));
}
