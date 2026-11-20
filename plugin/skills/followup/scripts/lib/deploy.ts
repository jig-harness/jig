/**
 * Whether a workflow run a follow-up arm waits for will settle by itself.
 *
 * A deploy arm records `pending` while its run has not finished, and the
 * dispatcher waits on it. That is right for a run that is starting or going.
 * It is wrong for a run that cannot start: when the workflow's concurrency
 * group is held, each new run sits waiting with no jobs and cancels the one
 * before it, so the run waited for never starts, and the wait only ends when
 * a person is told. `deploy-run` tells the two apart:
 *
 * - `finished`: the run completed, with its conclusion;
 * - `moving`: the run has not finished and nothing says it cannot start: it
 *   has jobs, no running holder is among the workflow's newest runs, the
 *   blockage is younger than the bound, or a run since the holder started
 *   ended in something other than cancelled;
 * - `stuck`: the run has not finished and has no jobs, an older run of its
 *   workflow is still running (the holder), every run that finished since
 *   the holder started ended cancelled, and the first run that waited on
 *   the holder was created at least the bound ago. The deploy is a
 *   person's to unblock, and the reading names the holder.
 *
 * The age is the blockage's, from the first run that waited on the holder,
 * not the waited-for run's own: a new merge replaces the pending run and
 * would otherwise keep the age young for as long as the queue is held. A
 * holder that is only slow looks the same as one that hangs, so the reading
 * names it for the person to judge.
 *
 * A run counts as holding the queue only when it is running and was made for
 * the same named branch: the forge does not name a run's concurrency group,
 * and a run with no branch name shares nothing that can be shown. The age
 * counts each run from its current attempt, and never from before the
 * holder's.
 *
 * It reads from the forge, one request each: the run, its jobs (one per
 * page, for the count) and its workflow's newest runs; a finished run needs
 * only the first.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { parseMs } from "../../../../shared/time.ts";

/** How long a run with no jobs waits before it counts as unable to start, by default. */
export const STUCK_AFTER_MS = 30 * 60_000;

/** The newest runs of the workflow read for its predecessors. */
const RUNS_PAGE = 20;

/** One workflow run as the forge describes it. */
export interface RunFacts {
  id: number;
  url: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  /** When the run's current attempt started; a rerun starts later than `createdAt`. */
  startedAt: string;
  workflowId: number;
  /** The branch the run was made for; `null` when the forge names none. */
  branch: string | null;
}

export type DeployState = "finished" | "moving" | "stuck";

export interface DeployReading {
  state: DeployState;
  run: RunFacts;
  /** How many jobs the run has. */
  jobs: number;
  /** The run still holding the workflow's queue, when one is among its newest runs. */
  holder: RunFacts | null;
  /** The conclusions of the runs that finished since the holder started, newest first. */
  before: string[];
  /** Why it reads as it does, in words. */
  reason: string;
}

/** A run object of the forge's REST answer; `null` when it is not one. */
export function runOf(value: unknown): RunFacts | null {
  if (!isRecord(value)) return null;
  const {
    id,
    html_url,
    status,
    conclusion,
    created_at,
    run_started_at,
    workflow_id,
    head_branch,
  } = value;
  if (
    typeof id !== "number" ||
    typeof html_url !== "string" ||
    typeof status !== "string" ||
    typeof created_at !== "string" ||
    typeof workflow_id !== "number"
  )
    return null;
  return {
    id,
    url: html_url,
    status,
    conclusion: typeof conclusion === "string" ? conclusion : null,
    createdAt: created_at,
    startedAt: typeof run_started_at === "string" ? run_started_at : created_at,
    workflowId: workflow_id,
    branch: typeof head_branch === "string" ? head_branch : null,
  };
}

/** The words for a span of milliseconds, in whole minutes. */
function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}

/**
 * The oldest run before `run` that is running for the same branch: what holds
 * the group. The forge does not name a run's concurrency group, and a
 * workflow may key it on the branch, so only a run for the same branch is
 * evidence that it shares the queue. A running run of another branch is
 * returned apart, as `elsewhere`: it may hold the queue (a group on a
 * constant) or not, and the reading names it without judging it stuck.
 */
function holderOf(
  run: RunFacts,
  runs: readonly RunFacts[],
): { holder: RunFacts | null; elsewhere: RunFacts | null } {
  const running = runs
    .filter((r) => r.id < run.id && r.status === "in_progress")
    .sort((a, b) => a.id - b.id);
  return {
    holder:
      run.branch === null
        ? null
        : (running.find((r) => r.branch === run.branch) ?? null),
    elsewhere:
      running.find((r) => r.branch === null || r.branch !== run.branch) ?? null,
  };
}

/** How a run reads at `nowMs`, from the run, its job count and its workflow's runs. */
export function classifyRun(
  run: RunFacts,
  jobs: number,
  runs: readonly RunFacts[],
  nowMs: number,
  stuckAfterMs: number = STUCK_AFTER_MS,
): DeployReading {
  const { holder, elsewhere } = holderOf(run, runs);
  const since =
    holder === null
      ? []
      : runs.filter(
          (r) =>
            r.id > holder.id &&
            r.branch === run.branch &&
            parseMs(r.startedAt) >= parseMs(holder.startedAt),
        );
  const before = since
    .filter((r) => r.id < run.id && r.status === "completed")
    .sort((a, b) => b.id - a.id)
    .map((r) => r.conclusion ?? "none");
  const read = (state: DeployState, reason: string): DeployReading => ({
    state,
    run,
    jobs,
    holder,
    before,
    reason,
  });
  if (run.status === "completed")
    return read("finished", `the run completed: ${run.conclusion ?? "none"}`);
  if (jobs > 0)
    return read("moving", `the run is ${run.status} with ${jobs} job(s)`);
  if (holder === null)
    return read(
      "moving",
      elsewhere === null
        ? `the run is ${run.status} with no jobs, and no running run of its workflow holds its queue among the newest runs read`
        : `the run is ${run.status} with no jobs; ${elsewhere.url} (branch ${elsewhere.branch ?? "unnamed"}) is running, and whether it holds this run's queue depends on the workflow's concurrency group, which is not read, so it is not judged stuck`,
    );
  if (before.some((c) => c !== "cancelled"))
    return read(
      "moving",
      `the run is ${run.status} with no jobs, but a run since ${holder.url} started ended other than cancelled (${before.join(", ")})`,
    );
  // A run's id keeps its creation order across reruns, so each run counts from
  // its current attempt, and nothing counts from before the holder's own.
  const first = Math.max(
    parseMs(holder.startedAt),
    Math.min(parseMs(run.startedAt), ...since.map((r) => parseMs(r.startedAt))),
  );
  const age = nowMs - first;
  if (!Number.isFinite(age) || age < stuckAfterMs)
    return read(
      "moving",
      `the run is ${run.status} with no jobs, held by ${holder.url} for ${Number.isFinite(age) ? minutes(age) : "an unreadable time"}, under the ${minutes(stuckAfterMs)} bound`,
    );
  return read(
    "stuck",
    `the run is ${run.status} with no jobs, and its queue has waited on ${holder.url} (${holder.status}) for ${minutes(age)}, past the ${minutes(stuckAfterMs)} bound, with ${before.length} cancelled run(s) in between: its workflow's concurrency group is held, so it cannot start unless that run ends`,
  );
}

/** One forge read: the parsed JSON of `gh api <path>`, or why it could not be read. */
export type ForgeRead = (
  path: string,
) => Promise<Outcome<unknown, "unreadable" | "rate-limited">>;

/** Read run `id` of the current repository and how it reads at `nowMs`. */
export async function readDeployRun(
  id: number,
  read: ForgeRead,
  nowMs: number,
  stuckAfterMs: number = STUCK_AFTER_MS,
): Promise<Outcome<DeployReading, "unreadable" | "rate-limited">> {
  const base = "repos/{owner}/{repo}/actions";
  const runRead = await read(`${base}/runs/${id}`);
  if (!runRead.ok) return runRead;
  const run = runOf(runRead.value);
  if (run === null)
    return failed(
      "unreadable",
      `the forge's answer for run ${id} is not a run`,
    );
  // A finished run's verdict is already known; the queue reads cannot change it.
  if (run.status === "completed")
    return ok(classifyRun(run, 0, [], nowMs, stuckAfterMs));
  const jobsRead = await read(`${base}/runs/${id}/jobs?per_page=1`);
  if (!jobsRead.ok) return jobsRead;
  const jobs = isRecord(jobsRead.value) ? jobsRead.value.total_count : null;
  if (typeof jobs !== "number")
    return failed(
      "unreadable",
      `the forge's answer for run ${id}'s jobs carries no count`,
    );
  const runsRead = await read(
    `${base}/workflows/${run.workflowId}/runs?per_page=${RUNS_PAGE}`,
  );
  if (!runsRead.ok) return runsRead;
  const listed = isRecord(runsRead.value) ? runsRead.value.workflow_runs : null;
  if (!Array.isArray(listed))
    return failed(
      "unreadable",
      `the forge's answer for workflow ${run.workflowId}'s runs is not a list`,
    );
  const runs = listed.map(runOf);
  const parsed = runs.filter((r) => r !== null);
  if (parsed.length !== runs.length)
    return failed(
      "unreadable",
      `${runs.length - parsed.length} of workflow ${run.workflowId}'s runs are not runs, so its queue cannot be judged`,
    );
  return ok(classifyRun(run, jobs, parsed, nowMs, stuckAfterMs));
}
