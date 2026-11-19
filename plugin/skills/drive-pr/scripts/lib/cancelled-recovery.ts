/**
 * Recover cancelled workflows once per head, sharing one durable budget across
 * entry points; each person's answer to the `cancelled-ci` park grants one more.
 * A run cancelled after the request, and not answered by its re-run, is
 * re-run once more under the same claim.
 */
import {
  RESULT_CONCLUSIONS,
  withoutSuperseded,
  type JobEvidence,
  type WorkflowRun,
} from "./status/workflow-runs.ts";
import type { PendingVerdict } from "./state/pass-handoff.ts";
import {
  labelCancelledRuns,
  labelRerunKey,
  LABEL_SETTLE_MS,
} from "./label-cancelled-runs.ts";
import { parseMs } from "../../../../shared/time.ts";

/**
 * How long a re-run may take to show a new attempt or a replacing run before
 * the recovery parks: a queued re-run can wait minutes for a runner.
 */
export const REPLACEMENT_WINDOW_MS = 10 * 60_000;

export type Recovery = "none" | "wait" | "parked" | "unknown";

/** A run the recovery re-ran: the attempt it had before, and when it was asked. */
export interface RequestedRun {
  id: number;
  workflowId: number;
  attempt: number;
  at: number;
}
export interface RecoveryRecord {
  firstSeen: number;
  requestedAt: number | null;
  workflowIds?: readonly number[];
  /** The runs the claim re-ran; empty on a claim an earlier release wrote. */
  requestedRuns?: readonly RequestedRun[];
  /** Further re-runs a person's answer granted on this head. */
  grants?: number;
  /** A grant that waits for a young claim's re-run to be judged. */
  grantPending?: boolean;
}
export interface RecoveryDeps {
  now(): number;
  observe(pr: string, head: string): Promise<RecoveryRecord>;
  claim(
    pr: string,
    head: string,
    workflowIds: readonly number[],
    requested: readonly RequestedRun[],
  ): Promise<boolean>;
  /** Extend a standing claim from `earlier` to `requested`; false when it changed. */
  extend(
    pr: string,
    head: string,
    earlier: readonly RequestedRun[],
    requested: readonly RequestedRun[],
  ): Promise<boolean>;
  /** Whether the head still stands; `unread` when the forge could not say. */
  confirm(pr: string, head: string): Promise<boolean | "unread">;
  rerunnable(pr: string, runs: readonly WorkflowRun[]): Promise<number[]>;
  /** `unread`: nothing was requested, because the forge could not confirm the head. */
  rerun(
    run: number,
  ): Promise<{ code: number; stderr: string; unread?: boolean }>;
  /**
   * Give back what a claim naming `claimed` holds for re-runs never requested:
   * it then names `kept`, and with `release` it is no longer spent.
   */
  withdrawClaim(
    pr: string,
    head: string,
    claimed: readonly RequestedRun[],
    kept: readonly RequestedRun[],
    release: boolean,
  ): Promise<void>;
  /** Give back the claim of a label-caused re-run never requested. */
  withdrawLabelRerun(pr: string, run: WorkflowRun): Promise<void>;
  park(pr: string, reason: string): Promise<void>;
  /**
   * Whether the caller still owns the pull request; asked before every forge
   * mutation and every park, and a refusal stands down without either.
   */
  mayMutate?(): Promise<boolean>;
  /** Release a claim a pending grant waited on; false when none was pending. */
  releaseGrant?(pr: string, head: string): Promise<boolean>;
  /** When each label was added or removed on the pull request, the CI hold's left out. */
  labelWrites?(pr: string): Promise<number[]>;
  /** When each label-caused re-run was requested, by {@link labelRerunKey}. */
  labelReruns?(pr: string): Promise<ReadonlyMap<string, number>>;
  /** Claim the one re-run of a label-caused cancellation; false when already claimed. */
  claimLabelRerun?(pr: string, run: WorkflowRun): Promise<boolean>;
}
/** How long a requested re-run has to produce its replacement. */
const LABEL_RETRY_WINDOW_MS = 60_000;
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
    .sort((a, b) => a.localeCompare(b))
    .join("\n");
}

export async function recoverCancelled(
  pr: string,
  head: string,
  jobs: readonly JobEvidence[],
  runs: readonly WorkflowRun[] | null,
  deps: RecoveryDeps,
): Promise<Recovery> {
  if (runs === null) return "unknown";
  const cancelled = unreplacedCancelledJobs(jobs, runs);
  if (cancelled.length === 0) return "none";
  const orphaned = orphanedRuns(cancelled, runs);
  if (orphaned === "unknown") return "unknown";
  if (orphaned.length === 0) return "wait";
  const now = deps.now();
  const caused = await recoverLabelCaused(pr, head, orphaned, runs, now, deps);
  if (caused !== null) return caused;
  const record = await deps.observe(pr, head);
  if (record.requestedAt !== null)
    return await judgeRequest(pr, head, orphaned, runs, record, now, deps);
  if (now - record.firstSeen < 30_000) return "wait";
  return await requestOpen(pr, head, orphaned, runs, record, now, deps);
}

/**
 * Whether a re-run that ended with a result answers an orphaned run: the run
 * itself, or one of its workflow that existed when the re-run was requested.
 * A run started after the request is a cancellation of its own.
 */
function answers(answered: readonly RequestedRun[], run: WorkflowRun): boolean {
  return answered.some(
    (request) =>
      request.workflowId === run.workflowId &&
      (request.id === run.id || cancelledBefore(run, request.at)),
  );
}

/**
 * Whether a run was already cancelled when the re-run was requested. A run
 * that started earlier may still have been in flight and cancelled afterward,
 * so its last update decides; without one the run is conservatively not
 * answered, and is requested once itself.
 */
function cancelledBefore(run: WorkflowRun, at: number): boolean {
  return (
    run.updatedAt !== undefined &&
    parseMs(run.startedAt) < floorSecond(at) &&
    parseMs(run.updatedAt) < floorSecond(at)
  );
}

/** Run times have one-second precision. */
function floorSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/**
 * Request the orphaned runs a released claim's re-run has not answered: a
 * grant re-runs what is still open, never a run its last re-run already
 * answered, and never while that re-run is going or inside its window.
 */
async function requestOpen(
  pr: string,
  head: string,
  orphaned: readonly WorkflowRun[],
  runs: readonly WorkflowRun[],
  record: RecoveryRecord,
  now: number,
  deps: RecoveryDeps,
): Promise<Recovery> {
  const observed = (record.requestedRuns ?? []).map((run) =>
    observeRequested(run, runs),
  );
  if (
    observed.some(
      (o) =>
        o.outcome === "pending" ||
        (o.outcome === "missing" && now - o.run.at < REPLACEMENT_WINDOW_MS),
    )
  )
    return "wait";
  const answered = observed
    .filter((o) => o.outcome === "result")
    .map((o) => o.run);
  // A request that never produced a result is retried as the run it named,
  // not as whichever cancelled run of its workflow is newest now.
  const missing = observed.filter((o) => o.outcome === "missing");
  const retried = missing.flatMap((o) => {
    const live = runs.find((other) => other.id === o.run.id);
    return live !== undefined
      ? [live]
      : orphaned.filter((run) => run.workflowId === o.run.workflowId);
  });
  const open = [
    ...retried,
    ...orphaned.filter(
      (run) =>
        !answers(answered, run) &&
        !missing.some((o) => o.run.workflowId === run.workflowId),
    ),
  ].filter((run, i, all) => all.findIndex((r) => r.id === run.id) === i);
  if (open.length === 0) return "none";
  if ((await deps.confirm(pr, head)) !== true) return "unknown";
  return await requestOnce(pr, head, open, record, deps, answered, "claim");
}

/**
 * Judge the runs the request re-ran, never the cancelled set computed again:
 * a run the drive's own label event started and its concurrency group
 * cancelled, or one the re-run itself cancelled, is not the re-run's failure.
 * Once every re-run run has a result, a cancelled run of the same workflow
 * that existed at the request is answered too; any other is requested once.
 */
async function judgeRequest(
  pr: string,
  head: string,
  orphaned: readonly WorkflowRun[],
  runs: readonly WorkflowRun[],
  record: RecoveryRecord,
  now: number,
  deps: RecoveryDeps,
): Promise<Recovery> {
  const requested = record.requestedRuns ?? [];
  const budget = budgetName(record);
  if (requested.length === 0) {
    // A claim an earlier release wrote names its workflows, not its runs.
    if (now - (record.requestedAt ?? 0) < REPLACEMENT_WINDOW_MS) return "wait";
    return await parkOrRegrant(
      pr,
      head,
      orphaned,
      orphaned,
      runs,
      deps,
      `${budget} was already requested and cancellation still has no replacement`,
    );
  }
  // A request that stopped part way left runs of other workflows cancelled
  // before it and never requested: they are owed now, whatever the requested
  // runs are doing, and a pending or missing sibling must not hold them back.
  const owed = orphaned.filter(
    (run) =>
      !requested.some(
        (request) =>
          request.id === run.id || request.workflowId === run.workflowId,
      ) && cancelledBefore(run, record.requestedAt ?? 0),
  );
  if (owed.length > 0) {
    if ((await deps.confirm(pr, head)) !== true) return "unknown";
    return await requestOnce(pr, head, owed, record, deps, requested, "extend");
  }
  const observed = requested.map((run) => observeRequested(run, runs));
  // A run past its window parks whatever its siblings are doing.
  const missing = observed.filter(
    (o) => o.outcome === "missing" && now - o.run.at >= REPLACEMENT_WINDOW_MS,
  );
  if (missing.length > 0) {
    const seen = missing.map((o) => `run ${o.run.id} ${o.seen}`).join("; ");
    return await parkOrRegrant(
      pr,
      head,
      missing.map((o) => o.run),
      orphaned,
      runs,
      deps,
      `${budget} was requested and, ${REPLACEMENT_WINDOW_MS / 60_000} minutes on, no attempt or result replaced it (${seen})`,
    );
  }
  if (observed.some((o) => o.outcome !== "result")) return "wait";
  const uncovered = orphaned.filter(
    (run) =>
      !answers(requested, run) &&
      !requested.some((request) => request.id === run.id),
  );
  if (uncovered.length === 0) return "none";
  // A cancellation that only ended now gets the same grace a first one gets.
  if (
    uncovered.some(
      (run) => now - parseMs(run.updatedAt ?? run.startedAt) < 30_000,
    )
  )
    return "wait";
  if ((await deps.confirm(pr, head)) !== true) return "unknown";
  return await requestOnce(
    pr,
    head,
    uncovered,
    record,
    deps,
    requested,
    "extend",
  );
}

/** A requested run with what was observed of it since its re-run was requested. */
interface Observed {
  run: RequestedRun;
  outcome: "result" | "pending" | "missing";
  seen: string;
}

/**
 * Whether the request's new attempt, or a run of its workflow started since
 * the request, ended with a result. A run of the workflow still going is
 * waited for; a new attempt that ended without a result (cancelled, skipped,
 * never started) leaves the request missing.
 */
function observeRequested(
  run: RequestedRun,
  runs: readonly WorkflowRun[],
): Observed {
  const live = runs.find((other) => other.id === run.id);
  const attempt =
    live !== undefined && live.attempt > run.attempt ? live : undefined;
  const since = runs.filter(
    (other) =>
      other.id !== run.id &&
      other.workflowId === run.workflowId &&
      parseMs(other.startedAt) >= floorSecond(run.at),
  );
  const candidates = [...(attempt === undefined ? [] : [attempt]), ...since];
  if (
    runs.some(
      (other) =>
        other.workflowId === run.workflowId && other.status !== "completed",
    )
  )
    return { run, outcome: "pending", seen: "is running" };
  if (candidates.some(endedWithResult))
    return { run, outcome: "result", seen: "has a result" };
  const seen =
    attempt !== undefined
      ? `got attempt ${attempt.attempt}, which ended ${attempt.conclusion ?? "without a conclusion"}`
      : live === undefined
        ? "is no longer listed on the head"
        : "got no new attempt";
  return { run, outcome: "missing", seen };
}

function endedWithResult(run: WorkflowRun): boolean {
  return (
    run.status === "completed" &&
    run.conclusion !== null &&
    RESULT_CONCLUSIONS.has(run.conclusion)
  );
}

function budgetName(record: RecoveryRecord): string {
  return (record.grants ?? 0) > 0
    ? "the re-run a person's answer granted"
    : "the once-per-head re-run";
}

/**
 * A request judged without a replacement parks, unless a person's answer
 * arrived while it was still in flight: that grant pays for the next request.
 */
async function parkOrRegrant(
  pr: string,
  head: string,
  named: readonly { id: number }[],
  orphaned: readonly WorkflowRun[],
  runs: readonly WorkflowRun[],
  deps: RecoveryDeps,
  why: string,
): Promise<Recovery> {
  const record = await deps.observe(pr, head);
  if (
    record.grantPending === true &&
    (await deps.releaseGrant?.(pr, head)) === true
  ) {
    const released = await deps.observe(pr, head);
    if (released.requestedAt === null)
      return await requestOpen(
        pr,
        head,
        orphaned,
        runs,
        released,
        Number.POSITIVE_INFINITY,
        deps,
      );
  }
  return await parkCancelled(deps, pr, head, named, record, why);
}

async function parkCancelled(
  deps: RecoveryDeps,
  pr: string,
  head: string,
  named: readonly { id: number }[],
  record: RecoveryRecord,
  why: string,
): Promise<"parked" | "unknown"> {
  if (deps.mayMutate !== undefined && !(await deps.mayMutate()))
    return "unknown";
  const commands = named.map((run) => `gh run rerun ${run.id}`).join("; ");
  const after =
    (record.grants ?? 0) > 0
      ? ` (a person's answer granted ${record.grants} more re-run(s) on this head)`
      : "";
  const reason = `Cancelled CI on head ${head}: run ${named.map((run) => run.id).join(", ")}: ${why}${after}. Answering "Re-run safely" and re-arming grants one more re-run, which the drive requests after the same checks; or inspect the workflow's event and permissions, run ${commands} when safe and re-arm the drive.`;
  await deps.park(pr, reason);
  console.error(reason);
  return "parked";
}

/**
 * The cancelled runs no replacement answers for. A replacement only answers for
 * its own workflow; another workflow still running on the head must not mask an
 * orphaned cancellation.
 */
function orphanedRuns(
  cancelled: readonly JobEvidence[],
  runs: readonly WorkflowRun[],
): WorkflowRun[] | "unknown" {
  const affected = runs.filter((run) =>
    cancelled.some((job) => job.suiteId === run.checkSuiteId),
  );
  if (
    cancelled.some(
      (job) => !affected.some((run) => run.checkSuiteId === job.suiteId),
    )
  )
    return "unknown";
  return affected.filter(
    (run) =>
      !runs.some(
        (other) =>
          other.workflowId === run.workflowId && other.status !== "completed",
      ) &&
      !affected.some(
        (other) => other.workflowId === run.workflowId && other.id > run.id,
      ),
  );
}

/**
 * Claim, then request the re-run, parking when it cannot be made safely. A
 * claim keeps `earlier`, the runs a released claim's re-run answered; an
 * extension adds `orphaned` to the standing claim that names `earlier`.
 */
async function requestOnce(
  pr: string,
  head: string,
  orphaned: readonly WorkflowRun[],
  record: RecoveryRecord,
  deps: RecoveryDeps,
  earlier: readonly RequestedRun[],
  mode: "claim" | "extend",
): Promise<Recovery> {
  const allowed = await deps.rerunnable(pr, orphaned);
  if (orphaned.some((run) => !allowed.includes(run.id)))
    return await parkCancelled(
      deps,
      pr,
      head,
      orphaned,
      record,
      "the run was created under the CI hold or its label history could not be verified; re-running it may replay the hold",
    );
  const at = deps.now();
  const requested = [
    ...earlier,
    ...orphaned.map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      attempt: run.attempt,
      at,
    })),
  ];
  // Claim BEFORE the API mutation: an ambiguous response or a process death
  // can never grant another invocation permission to replay the request.
  const claimed =
    mode === "claim"
      ? await deps.claim(
          pr,
          head,
          orphaned.map((run) => run.workflowId),
          requested,
        )
      : await deps.extend(pr, head, earlier, requested);
  if (!claimed) return "wait";
  const sent: WorkflowRun[] = [];
  const refused = await requestRuns(
    pr,
    head,
    orphaned,
    deps,
    mode === "extend"
      ? "re-run 1/1 of a workflow the request did not cover"
      : budgetName(record) === "the once-per-head re-run"
        ? "re-run 1/1"
        : budgetName(record),
    sent,
  );
  if (refused === UNREAD) {
    // The forge could not confirm the head, so the runs not yet requested stay
    // owed: a re-armed drive requests them instead of judging a request that
    // never left.
    const release = mode === "claim" && sent.length === 0;
    const kept = release
      ? (record.requestedRuns ?? [])
      : requested.filter(
          (run) =>
            earlier.includes(run) || sent.some((other) => other.id === run.id),
        );
    await deps.withdrawClaim(pr, head, requested, kept, release);
    return "unknown";
  }
  if (refused === "head-moved") return "unknown";
  if (refused !== null)
    return await parkCancelled(deps, pr, head, orphaned, record, refused);
  return "wait";
}

/**
 * A re-run raises its run's attempt, so a retry still inside its replacement
 * window is found by run, whichever attempt it is on now.
 */
function labelRetryPending(
  orphaned: readonly WorkflowRun[],
  requested: ReadonlyMap<string, number>,
  now: number,
): boolean {
  return orphaned.some((run) =>
    [...requested].some(
      ([key, at]) =>
        key.startsWith(`${run.id}:`) && now - at < LABEL_RETRY_WINDOW_MS,
    ),
  );
}

/** The runs this drive may replay and won the durable claim on; `null` when none may be replayed. */
async function claimSafeRuns(
  pr: string,
  fresh: readonly WorkflowRun[],
  deps: RecoveryDeps,
): Promise<WorkflowRun[] | null> {
  const allowed = await deps.rerunnable(pr, fresh);
  const safe = fresh.filter((run) => allowed.includes(run.id));
  if (safe.length === 0) return null;
  const claimed: WorkflowRun[] = [];
  for (const run of safe)
    if (await deps.claimLabelRerun?.(pr, run)) claimed.push(run);
  return claimed;
}

/**
 * Re-run the cancellations a label write caused, outside the head's budget:
 * the drive's own label writes start them, so counting them would make every
 * re-arm spend the re-run it then parks on. Each run's attempt is re-run once,
 * claimed durably before the request. `null` hands the runs to the head's
 * budget: none was caused by a label write, every one was already re-run
 * longer ago than the replacement window, or none may be replayed safely.
 */
async function recoverLabelCaused(
  pr: string,
  head: string,
  orphaned: readonly WorkflowRun[],
  runs: readonly WorkflowRun[],
  now: number,
  deps: RecoveryDeps,
): Promise<"wait" | "parked" | "unknown" | null> {
  if (deps.labelWrites === undefined || deps.claimLabelRerun === undefined)
    return null;
  const writes = await deps.labelWrites(pr);
  const requested = (await deps.labelReruns?.(pr)) ?? new Map();
  if (labelRetryPending(orphaned, requested, now)) return "wait";
  const caused = labelCancelledRuns(orphaned, runs, writes);
  if (caused.length === 0) return null;
  // The label write's other runs may still be arriving to replace these.
  if (now - Math.max(...writes) < LABEL_SETTLE_MS) return "wait";
  const fresh = caused.filter((run) => !requested.has(labelRerunKey(run)));
  if (fresh.length === 0)
    return caused.some(
      (run) =>
        now - (requested.get(labelRerunKey(run)) ?? 0) < LABEL_RETRY_WINDOW_MS,
    )
      ? "wait"
      : null;
  return await rerunFreshLabelCaused(pr, head, fresh, deps);
}

/** Claim and request the one re-run of each label-caused run not yet re-run. */
async function rerunFreshLabelCaused(
  pr: string,
  head: string,
  fresh: readonly WorkflowRun[],
  deps: RecoveryDeps,
): Promise<"wait" | "parked" | "unknown" | null> {
  if ((await deps.confirm(pr, head)) !== true) return "unknown";
  const claimed = await claimSafeRuns(pr, fresh, deps);
  if (claimed === null) return null;
  if (claimed.length === 0) return "wait";
  const sent: WorkflowRun[] = [];
  const answer = await requestRuns(
    pr,
    head,
    claimed,
    deps,
    "the re-run of a label write's cancellation, outside the head's budget,",
    sent,
  );
  if (answer === UNREAD) {
    for (const run of claimed)
      if (!sent.includes(run)) await deps.withdrawLabelRerun(pr, run);
    return "unknown";
  }
  if (answer === "head-moved") return "unknown";
  if (answer !== null)
    return await parkCancelled(
      deps,
      pr,
      head,
      claimed,
      await deps.observe(pr, head),
      answer,
    );
  return "wait";
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

/** A request stopped before it left, because the forge could not confirm the head. */
const UNREAD = "unread";

/** Request each run, adding those requested to `sent`; why it stopped, or `null`. */
async function requestRuns(
  pr: string,
  head: string,
  runs: readonly WorkflowRun[],
  deps: RecoveryDeps,
  budget: string,
  sent: WorkflowRun[],
): Promise<string | null> {
  for (const run of runs) {
    const confirmed = await deps.confirm(pr, head);
    if (confirmed === "unread") return UNREAD;
    if (!confirmed) return "head-moved";
    // Nothing was sent: the runs not yet requested go back to the next owner.
    if (deps.mayMutate !== undefined && !(await deps.mayMutate()))
      return UNREAD;
    const answer = await deps.rerun(run.id);
    if (answer.unread === true) return UNREAD;
    if (answer.code !== 0)
      return `the forge refused or could not confirm the re-run: ${answer.stderr.trim()}`;
    sent.push(run);
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
    RESULT_CONCLUSIONS.has(other.conclusion)
  );
}
