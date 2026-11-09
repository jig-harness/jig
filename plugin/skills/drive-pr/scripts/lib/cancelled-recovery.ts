/** Recover cancelled workflows once per head, sharing one durable budget across entry points. */
import {
  withoutSuperseded,
  type JobEvidence,
  type WorkflowRun,
} from "./status/workflow-runs.ts";
export interface RecoveryRecord {
  firstSeen: number;
  requestedAt: number | null;
  workflowIds?: readonly number[];
}
export interface RecoveryDeps {
  now(): number;
  observe(pr: string, head: string): Promise<RecoveryRecord>;
  claim(
    pr: string,
    head: string,
    workflowIds: readonly number[],
  ): Promise<boolean>;
  confirm(pr: string, head: string): Promise<boolean>;
  rerunnable(pr: string, runs: readonly WorkflowRun[]): Promise<number[]>;
  rerun(run: number): Promise<{ code: number; stderr: string }>;
  park(pr: string, reason: string): Promise<void>;
}
export async function recoverCancelled(
  pr: string,
  head: string,
  jobs: readonly JobEvidence[],
  runs: readonly WorkflowRun[] | null,
  deps: RecoveryDeps,
): Promise<"none" | "wait" | "parked" | "unknown"> {
  if (runs === null) return "unknown";
  const cancelled = unreplacedCancelledJobs(jobs, runs);
  if (cancelled.length === 0) return "none";
  const affected = runs.filter((run) =>
    cancelled.some((job) => job.suiteId === run.checkSuiteId),
  );
  if (
    cancelled.some(
      (job) => !affected.some((run) => run.checkSuiteId === job.suiteId),
    )
  )
    return "unknown";
  // A replacement only answers for its own workflow; another workflow still
  // running on the head must not mask an orphaned cancellation.
  const orphaned = affected.filter(
    (run) =>
      !runs.some(
        (other) =>
          other.workflowId === run.workflowId && other.status !== "completed",
      ) &&
      !affected.some(
        (other) => other.workflowId === run.workflowId && other.id > run.id,
      ),
  );
  if (orphaned.length === 0) return "wait";
  const record = await deps.observe(pr, head);
  const now = deps.now();
  if (record.requestedAt !== null) {
    if (now - record.requestedAt < 60_000) return "wait";
    return await park(
      "the once-per-head re-run was already requested and cancellation still has no replacement",
    );
  }
  if (now - record.firstSeen < 30_000) return "wait";
  if (!(await deps.confirm(pr, head))) return "unknown";
  const allowed = await deps.rerunnable(pr, orphaned);
  if (orphaned.some((run) => !allowed.includes(run.id)))
    return await park(
      "the run was created under the CI hold or its label history could not be verified; re-running it may replay the hold",
    );
  // Claim BEFORE the API mutation: an ambiguous response or a process death
  // can never grant another invocation permission to replay the request.
  if (
    !(await deps.claim(
      pr,
      head,
      orphaned.map((run) => run.workflowId),
    ))
  )
    return "wait";
  const requested = await requestRuns(pr, head, orphaned, deps);
  if (requested === "head-moved") return "unknown";
  if (requested !== null) return await park(requested);
  return "wait";

  async function park(why: string): Promise<"parked"> {
    const commands = orphaned.map((run) => `gh run rerun ${run.id}`).join("; ");
    const reason = `Cancelled CI on head ${head}: run ${orphaned.map((run) => run.id).join(", ")}: ${why}. Inspect the workflow's event and permissions, then run ${commands} when safe and re-arm the drive.`;
    await deps.park(pr, reason);
    console.error(reason);
    return "parked";
  }
}

function unreplacedCancelledJobs(
  jobs: readonly JobEvidence[],
  runs: readonly WorkflowRun[],
): JobEvidence[] {
  return withoutSuperseded(jobs, runs).filter(
    (job) =>
      job.status === "completed" &&
      job.conclusion === "cancelled" &&
      !jobs.some((other) => sameCheck(job, other) && laterResult(job, other)),
  );
}

async function requestRuns(
  pr: string,
  head: string,
  runs: readonly WorkflowRun[],
  deps: RecoveryDeps,
): Promise<string | null> {
  for (const run of runs) {
    if (!(await deps.confirm(pr, head))) return "head-moved";
    const answer = await deps.rerun(run.id);
    if (answer.code !== 0)
      return `the forge refused or could not confirm the re-run: ${answer.stderr.trim()}`;
    console.error(
      `cancelled CI recovery: requested run ${run.id} (re-run 1/1 on head ${head}); waiting for its replacement`,
    );
  }
  return null;
}

function sameCheck(job: JobEvidence, other: JobEvidence): boolean {
  return (
    job.name !== undefined &&
    other.name === job.name &&
    other.suiteId === job.suiteId
  );
}
function laterResult(job: JobEvidence, other: JobEvidence): boolean {
  if (job.id === undefined || other.id === undefined || other.id <= job.id)
    return false;
  return (
    other.status === "completed" &&
    other.conclusion !== null &&
    ["success", "failure", "neutral", "timed_out"].includes(other.conclusion)
  );
}
