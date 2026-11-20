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
 *   has jobs, it is younger than the bound, or the runs before it did not
 *   all end cancelled;
 * - `stuck`: the run has not finished, has no jobs, was created at least the
 *   bound ago, and the runs of its workflow before it that finished all
 *   ended cancelled. The deploy is a person's to unblock.
 *
 * It reads three things from the forge, one request each: the run, its jobs
 * (one per page, for the count) and its workflow's newest runs.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { parseMs } from "../../../../shared/time.ts";

/** How long a run with no jobs waits before it counts as unable to start, by default. */
export const STUCK_AFTER_MS = 30 * 60_000;

/** The finished runs before the waited-for one whose conclusions decide whether its queue is held. */
const PREDECESSORS = 3;

/** The newest runs of the workflow read for its predecessors. */
const RUNS_PAGE = 20;

/** One workflow run as the forge describes it. */
export interface RunFacts {
  id: number;
  url: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  workflowId: number;
}

export type DeployState = "finished" | "moving" | "stuck";

export interface DeployReading {
  state: DeployState;
  run: RunFacts;
  /** How many jobs the run has. */
  jobs: number;
  /** The conclusions of the finished runs of its workflow before it, newest first. */
  before: string[];
  /** Why it reads as it does, in words. */
  reason: string;
}

/** A run object of the forge's REST answer; `null` when it is not one. */
export function runOf(value: unknown): RunFacts | null {
  if (!isRecord(value)) return null;
  const { id, html_url, status, conclusion, created_at, workflow_id } = value;
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
    workflowId: workflow_id,
  };
}

/** The finished runs older than `run` among `runs`, newest first, at most `PREDECESSORS`. */
function predecessors(run: RunFacts, runs: readonly RunFacts[]): string[] {
  return runs
    .filter((r) => r.id < run.id && r.status === "completed")
    .sort((a, b) => b.id - a.id)
    .slice(0, PREDECESSORS)
    .map((r) => r.conclusion ?? "none");
}

/** The words for a span of milliseconds, in whole minutes. */
function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}

/** How a run reads at `nowMs`, from the run, its job count and its workflow's runs. */
export function classifyRun(
  run: RunFacts,
  jobs: number,
  runs: readonly RunFacts[],
  nowMs: number,
  stuckAfterMs: number = STUCK_AFTER_MS,
): DeployReading {
  const before = predecessors(run, runs);
  const read = (state: DeployState, reason: string): DeployReading => ({
    state,
    run,
    jobs,
    before,
    reason,
  });
  if (run.status === "completed")
    return read("finished", `the run completed: ${run.conclusion ?? "none"}`);
  const age = nowMs - parseMs(run.createdAt);
  if (jobs > 0)
    return read("moving", `the run is ${run.status} with ${jobs} job(s)`);
  if (!Number.isFinite(age) || age < stuckAfterMs)
    return read(
      "moving",
      `the run is ${run.status} with no jobs yet, created ${Number.isFinite(age) ? minutes(age) : "at an unreadable time"} ago, under the ${minutes(stuckAfterMs)} bound`,
    );
  if (before.length === 0 || before.some((c) => c !== "cancelled"))
    return read(
      "moving",
      `the run is ${run.status} with no jobs for ${minutes(age)}, but the runs before it did not all end cancelled (${before.join(", ") || "none finished"})`,
    );
  return read(
    "stuck",
    `the run is ${run.status} with no jobs for ${minutes(age)}, past the ${minutes(stuckAfterMs)} bound, and the ${before.length} finished run(s) before it all ended cancelled: its workflow's concurrency group is held, so it cannot start`,
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
  const runs = listed.map(runOf).filter((r) => r !== null);
  return ok(classifyRun(run, jobs, runs, nowMs, stuckAfterMs));
}
