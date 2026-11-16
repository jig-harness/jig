/**
 * Recover cancelled workflows once per head, sharing one durable budget across
 * entry points; each person's answer to the `cancelled-ci` park grants one more.
 */
import {
  withoutSuperseded,
  type JobEvidence,
  type WorkflowRun,
} from "./status/workflow-runs.ts";
import type { PendingVerdict } from "./state/pass-handoff.ts";
export interface RecoveryRecord {
  firstSeen: number;
  requestedAt: number | null;
  workflowIds?: readonly number[];
  /** Further re-runs a person's answer granted on this head. */
  grants?: number;
  /** A grant waiting for a claim younger than the replacement window to age out. */
  grantPending?: boolean;
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
  /** Release a claim a pending grant waited on; false when none was pending. */
  releaseGrant?(pr: string, head: string): Promise<boolean>;
}
/** The `cancelled-ci` park's option whose answer grants one more re-run. */
export const RERUN_OPTION = "rerun";

/**
 * Whether a person's answers to the `cancelled-ci` park all choose the re-run
 * option; a provisional decision, a disputed set or another option grants none.
 */
export function answerGrantsRerun(verdict: PendingVerdict): boolean {
  if (verdict.key !== "cancelled-ci" || verdict.provisional === true)
    return false;
  const option = verdict.decision?.call.options.find(
    (o) => o.id === RERUN_OPTION,
  );
  // A note may narrow the option with a condition no recovery can establish:
  // such an answer goes to the pass, which honors or parks it.
  return (
    option !== undefined &&
    verdict.answers.length > 0 &&
    verdict.answers.every(
      (a) =>
        a.choice?.option === option.name && (a.choice.note ?? "").trim() === "",
    )
  );
}

/** The head the `cancelled-ci` park was framed for, or null when it names none. */
export function answeredHead(verdict: PendingVerdict): string | null {
  const text = [
    ...(verdict.decision?.steps ?? []),
    verdict.decision?.alreadyDone ?? "",
  ].join("\n");
  return /Cancelled CI on head ([0-9a-f]{7,64})\b/.exec(text)?.[1] ?? null;
}

/** The answers a grant is for, so that reading them again grants nothing more. */
export function grantKey(verdict: PendingVerdict): string {
  return verdict.answers
    .map((a) => `${a.url} ${a.at}`)
    .sort()
    .join("\n");
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
  const now = deps.now();
  const record = await observeReleasing(pr, head, now, deps);
  const granted = (record.grants ?? 0) > 0;
  if (record.requestedAt !== null) {
    if (now - record.requestedAt < 60_000) return "wait";
    return await park(
      granted
        ? "the re-run a person's answer granted was requested and cancellation still has no replacement"
        : "the once-per-head re-run was already requested and cancellation still has no replacement",
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
  const requested = await requestRuns(
    pr,
    head,
    orphaned,
    deps,
    granted ? "the re-run a person's answer granted" : "re-run 1/1",
  );
  if (requested === "head-moved") return "unknown";
  if (requested !== null) return await park(requested);
  return "wait";

  async function park(why: string): Promise<"parked"> {
    const commands = orphaned.map((run) => `gh run rerun ${run.id}`).join("; ");
    const after = granted
      ? ` (a person's answer granted ${record.grants} more re-run(s) on this head)`
      : "";
    const reason = `Cancelled CI on head ${head}: run ${orphaned.map((run) => run.id).join(", ")}: ${why}${after}. Answering "Re-run safely" and re-arming grants one more re-run, which the drive requests after the same checks; or inspect the workflow's event and permissions, run ${commands} when safe and re-arm the drive.`;
    await deps.park(pr, reason);
    console.error(reason);
    return "parked";
  }
}

/** The head's record, its claim released first when a pending grant waited on it. */
async function observeReleasing(
  pr: string,
  head: string,
  now: number,
  deps: RecoveryDeps,
): Promise<RecoveryRecord> {
  const record = await deps.observe(pr, head);
  const aged =
    record.requestedAt !== null && now - record.requestedAt >= 60_000;
  if (
    aged &&
    record.grantPending === true &&
    (await deps.releaseGrant?.(pr, head)) === true
  )
    return await deps.observe(pr, head);
  return record;
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
  budget: string,
): Promise<string | null> {
  for (const run of runs) {
    if (!(await deps.confirm(pr, head))) return "head-moved";
    const answer = await deps.rerun(run.id);
    if (answer.code !== 0)
      return `the forge refused or could not confirm the re-run: ${answer.stderr.trim()}`;
    console.error(
      `cancelled CI recovery: requested run ${run.id} (${budget} on head ${head}); waiting for its replacement`,
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
