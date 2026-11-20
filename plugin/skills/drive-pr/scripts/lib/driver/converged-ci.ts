/**
 * What the `converged` label does to CI on the head it was written for. The
 * stop's label write adds `converged` and removes `driving`; a repository
 * whose workflows listen for label events starts runs on the verified head
 * for each, and those runs can cancel each other under a concurrency group, or
 * re-run the suite and meet a flaky test. The newest runs then decide the
 * required checks, so a pull request labelled `converged` can be left
 * blocked, with no drive running to notice.
 *
 * So after the stop's label write, while the drive still holds the pull
 * request's lock, it watches the verified head until its CI verdict settles:
 *
 * - green: the label stands;
 * - a cancellation: the cancelled-run recovery (`cancelled-recovery.ts`)
 *   takes it, which re-runs a label-caused cancellation once per run attempt
 *   and parks `cancelled-ci` when that does not bring a replacement;
 * - a job the runner stopped at its time limit: a failure no re-run clears,
 *   so the drive parks, naming the job, its limit and its run time;
 * - a failure in a run a label write started ({@link labelStarted}, its first
 *   attempt only): re-run once, claimed in the same table the label-caused
 *   cancellations use, so a run is re-run once however many callers see it;
 * - anything else, a failure its one re-run did not clear, or a verdict still
 *   unsettled when the watch's window ends: the drive parks, naming the runs;
 *   a window in which the head's CI never read leaves the label standing.
 *
 * A run counts as started by the write only when the forge created it within
 * the label-run window after a label event; a workflow created later is not
 * attributed to the write, and its failure parks rather than being re-run. A
 * head that moved, or a pull request no longer open, ends the watch: the label
 * write's own head guard and the next drive judge the new head.
 */
import {
  labelRerunKey,
  labelStarted,
  LABEL_SETTLE_MS,
} from "../label-cancelled-runs.ts";
import {
  isTimedOut,
  type LiveRecovery,
  recoveryLabel,
  timedOutWords,
} from "../cancelled-recovery-reads.ts";
import type { FailedRun, WorkflowRun } from "../status/workflow-runs.ts";
import type { TimedOutJob } from "../job-timeout.ts";

/** What the watch reads of the pull request: whether it is open, and its head. */
export interface PullRequestRead {
  open: boolean;
  head: string;
}

/** The exact-head CI evidence the final CI re-gate reads. */
export interface CiRead {
  /** `green`, `pending: …`, `failing: …`, `cancelled: …`, `held: …` or `unknown: …`. */
  verdict: string;
  /** The workflow runs behind the failing check-runs; `null` when unread. */
  failingRuns: FailedRun[] | null;
  /** Failing commit statuses' names; `null` when unread. */
  failingStatusNames: string[] | null;
}

export interface ConvergedCiDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  pollMs: number;
  /** How long after the write every run it starts exists: {@link LABEL_SETTLE_MS} live. */
  settleMs: number;
  /** How long the watch waits for the verdict to settle, from the label write. */
  windowMs: number;
  pullRequest(pr: string): Promise<PullRequestRead | null>;
  /** `listing-cut-short` when the check-runs listing stopped at a bound; `null` when unread. */
  ci(pr: string, head: string): Promise<CiRead | "listing-cut-short" | null>;
  /** Every workflow run on the head, each with its attempt; `null` when unread. */
  workflowRuns(head: string): Promise<WorkflowRun[] | null>;
  /** When each label was added or removed, the CI hold's left out; `null` when unread. */
  labelWrites(pr: string): Promise<number[] | null>;
  /** When each label-caused re-run was requested, by {@link labelRerunKey}. */
  labelReruns(pr: string): Promise<ReadonlyMap<string, number>>;
  /** The ids of these runs a re-run may replay: none created under the CI hold. */
  rerunnable(pr: string, runs: readonly FailedRun[]): Promise<number[]>;
  /** Claim the one re-run of this run attempt; false when it was claimed before. */
  claimRerun(pr: string, run: WorkflowRun): Promise<boolean>;
  /** Re-run the run's failed jobs after the head and CI-hold checks. */
  rerunFailed(
    pr: string,
    head: string,
    run: number,
    mayMutate: () => Promise<boolean>,
  ): Promise<{ ok: boolean; indeterminate?: boolean; detail: string }>;
  /**
   * The cancelled-run recovery on the head; `mayMutate` is asked at its
   * mutation boundary, after its own fence and before it claims or re-runs.
   */
  recoverCancelled(
    pr: string,
    head: string,
    mayMutate: () => Promise<boolean>,
  ): Promise<LiveRecovery>;
  /** The jobs the runner stopped at their time limit on the head, read only. */
  timedOutJobs?(head: string): Promise<readonly TimedOutJob[]>;
  /**
   * Whether this drive still owns the pull request. Asked before every
   * change to CI and before a park; unset means owned.
   */
  owned?(): Promise<Ownership>;
}

/**
 * `lost`: a takeover claim newer than this drive's own is on the pull
 * request. `unreadable`: the claims did not read, which proves neither
 * answer, so nothing may change and nothing may settle on it.
 */
export type Ownership = "ours" | "lost" | "unreadable";

/**
 * How the watch ended: `stands` leaves the converged stop as it is;
 * `parked` means the cancelled-run recovery parked `cancelled-ci` itself;
 * `park` asks the drive to park with `reason`; `unverified` means the watch
 * could not tell whether this drive still owns the pull request, so the
 * stop is settled for a next drive to judge the head again;
 * `listing-cut-short` means the head's check-runs listing stopped at a bound,
 * a named stop the dispatcher re-drives once per head.
 */
export type ConvergedCiVerdict =
  | { kind: "stands"; why: string }
  | { kind: "unverified"; why: string }
  | { kind: "parked" }
  | { kind: "listing-cut-short" }
  | { kind: "park"; reason: string; labelCaused: boolean };

/** How long after a requested re-run the run must show its new attempt. */
const RERUN_SHOWS_MS = 60_000;

/** What one reading asks for next. */
type Step =
  | { next: "wait"; saw: string }
  | { next: "park"; reason: string; labelCaused: boolean };

/** What one failing reading asks for: a {@link Step}, or the runs to re-run. */
type Judged = Step | { next: "rerun"; runs: WorkflowRun[] };

/** What one failing run asks for: a {@link Step}, or `rerun` when a re-run may replay it. */
function judgeRun(
  run: WorkflowRun,
  head: string,
  writes: readonly number[],
  reruns: ReadonlyMap<string, number>,
  now: number,
): Step | "rerun" {
  if (run.status !== "completed")
    return {
      next: "wait",
      saw: `run ${run.id} attempt ${run.attempt} is ${run.status}`,
    };
  // The check read and the run listing are separate reads: a newer attempt
  // that succeeded is no failure, and the CI read is repeated.
  if (["success", "neutral", "skipped"].includes(run.conclusion ?? ""))
    return {
      next: "wait",
      saw: `run ${run.id} attempt ${run.attempt} concluded ${run.conclusion}, newer than the failure read`,
    };
  const requested = reruns.get(labelRerunKey({ id: run.id, attempt: 1 }));
  if (run.attempt === 1 && requested !== undefined) {
    if (now - requested < RERUN_SHOWS_MS)
      return {
        next: "wait",
        saw: `run ${run.id}'s re-run was just requested`,
      };
    return {
      next: "park",
      reason: `run ${run.id} on head ${head} failed in a run a label write started, and its re-run, requested ${Math.round((now - requested) / 1000)}s ago, shows no new attempt`,
      labelCaused: true,
    };
  }
  if (!labelStarted(run, writes))
    return {
      next: "park",
      reason: `run ${run.id} on head ${head} failed after the converged label was written, and no label write started it, so the drive does not re-run it`,
      labelCaused: false,
    };
  if (run.attempt !== 1)
    return {
      next: "park",
      reason: `run ${run.id} on head ${head} failed again on attempt ${run.attempt}, after its one re-run for the label write that started it`,
      labelCaused: true,
    };
  return "rerun";
}

/**
 * Judge the whole collection: a park anywhere ends the watch, a wait is kept
 * while the other runs are examined, and every run a re-run may replay is
 * retried whatever the others are doing.
 */
function judgeEach(
  failing: readonly { id: number }[],
  runs: readonly WorkflowRun[],
  head: string,
  writes: readonly number[],
  reruns: ReadonlyMap<string, number>,
  now: number,
  verdict: string,
): Judged | { toRerun: WorkflowRun[]; waiting: string | null } {
  const toRerun: WorkflowRun[] = [];
  let waiting: string | null = null;
  for (const failed of failing) {
    const run = runs.find((r) => r.id === failed.id);
    const judged =
      run === undefined
        ? ({
            next: "wait",
            saw: `${verdict} (run ${failed.id} not listed yet)`,
          } as const)
        : judgeRun(run, head, writes, reruns, now);
    if (judged === "rerun" && run !== undefined) toRerun.push(run);
    else if (typeof judged !== "string" && judged.next === "park")
      return judged;
    else if (typeof judged !== "string") waiting ??= judged.saw;
  }
  return { toRerun, waiting };
}

/** The wait or park a failure with no run to re-run asks for, `null` when runs are behind it. */
function unrerunnable(read: CiRead, head: string): Step | null {
  const failing = read.failingRuns;
  if (failing === null || read.failingStatusNames === null)
    return { next: "wait", saw: `${read.verdict} (its runs did not read)` };
  if (read.failingStatusNames.length > 0)
    return {
      next: "park",
      reason: `commit status ${read.failingStatusNames.join(", ")} failed on head ${head} after the converged label was written; a commit status has no run the drive can re-run`,
      labelCaused: false,
    };
  if (failing.length === 0)
    return {
      next: "park",
      reason: `required CI on head ${head} reads ${read.verdict} after the converged label was written, with no workflow run behind it to re-run`,
      labelCaused: false,
    };
  return null;
}

/**
 * Judge each failing run: a re-run still going or just requested waits; a
 * first attempt a label write started, that may be replayed and is not yet
 * claimed, is re-run; anything else parks, naming the run.
 */
async function judgeFailure(
  pr: string,
  head: string,
  read: CiRead,
  deps: ConvergedCiDeps,
): Promise<Judged> {
  const unjudged = unrerunnable(read, head);
  if (unjudged !== null) return unjudged;
  const failing = read.failingRuns ?? [];
  const [runs, writes, reruns] = await Promise.all([
    deps.workflowRuns(head),
    deps.labelWrites(pr),
    deps.labelReruns(pr),
  ]);
  if (runs === null || writes === null)
    return {
      next: "wait",
      saw: `${read.verdict} (the head's runs or the label history did not read)`,
    };
  const sorted = judgeEach(
    failing,
    runs,
    head,
    writes,
    reruns,
    deps.now(),
    read.verdict,
  );
  if ("next" in sorted) return sorted;
  const { toRerun, waiting } = sorted;
  if (toRerun.length === 0)
    return {
      next: "wait",
      saw: waiting ?? `${read.verdict} (nothing to judge)`,
    };
  // Asked only for the runs a re-run would replay: it reads the timeline again.
  const allowed = await deps.rerunnable(
    pr,
    failing.filter((f) => toRerun.some((r) => r.id === f.id)),
  );
  const held = toRerun.find((run) => !allowed.includes(run.id));
  if (held !== undefined)
    return {
      next: "park",
      reason: `run ${held.id} on head ${head} failed in a run a label write started, and it may not be re-run (created under the CI hold, or the hold did not read)`,
      labelCaused: true,
    };
  return { next: "rerun", runs: toRerun };
}

/** Claim and request each run's one re-run; a park when a request fails. */
async function rerun(
  pr: string,
  head: string,
  runs: readonly WorkflowRun[],
  deps: ConvergedCiDeps,
): Promise<Step | ConvergedCiVerdict> {
  for (const run of runs) {
    // The reads before this claim, and the requests before it, took time.
    const held = await ownershipHold(deps);
    if (held !== null) return held;
    if (!(await deps.claimRerun(pr, run))) continue;
    const asked = await deps.rerunFailed(
      pr,
      head,
      run.id,
      async () => (await ownershipOf(deps)) === "ours",
    );
    // An indeterminate answer may still have started the run: the claim is
    // recorded, so the next reading looks for its new attempt and parks when
    // none appears.
    if (!asked.ok && asked.indeterminate !== true)
      return {
        next: "park",
        reason: `run ${run.id} on head ${head} failed in a run a label write started, and its re-run was not accepted: ${asked.detail}`,
        labelCaused: true,
      };
    if (!asked.ok) {
      console.error(
        `converged CI: the re-run of run ${run.id} on head ${head} is unconfirmed (${asked.detail}); watching for its new attempt`,
      );
      continue;
    }
    console.error(
      `converged CI: re-ran run ${run.id} on head ${head}: it failed in a run the converged label's write started (once per run)`,
    );
  }
  return {
    next: "wait",
    saw: `the re-run of run(s) ${runs.map((r) => r.id).join(", ")}`,
  };
}

async function ownershipOf(deps: ConvergedCiDeps): Promise<Ownership> {
  if (deps.owned === undefined) return "ours";
  try {
    return await deps.owned();
  } catch {
    return "unreadable";
  }
}

/** Why a watch must not change CI or settle on what it saw: `null` while the drive owns the pull request. */
async function ownershipHold(
  deps: ConvergedCiDeps,
): Promise<ConvergedCiVerdict | Step | null> {
  const owner = await ownershipOf(deps);
  if (owner === "ours") return null;
  if (owner === "lost") return { kind: "stands", why: LOST_WHY };
  return { next: "wait", saw: "the drive's ownership did not read" };
}

/** Whether the failure is nothing but cancelled runs (or a `cancelled:` verdict). */
function onlyCancelled(read: CiRead): boolean {
  const failing = read.failingRuns ?? [];
  return (
    read.verdict.startsWith("cancelled:") ||
    (failing.length > 0 &&
      (read.failingStatusNames ?? []).length === 0 &&
      failing.every((r) => r.conclusion === "cancelled"))
  );
}

/**
 * The cancelled-run recovery, when the failure is only cancellations: its
 * answer, or `null` to judge the head as a failure.
 */
async function recoverCancelledStep(
  pr: string,
  head: string,
  read: CiRead,
  deps: ConvergedCiDeps,
): Promise<Step | ConvergedCiVerdict | null> {
  const verdict = read.verdict;
  if (!onlyCancelled(read)) {
    // A job the runner stopped at its time limit beside a real failure is
    // still named: the park below says it, not only the failure.
    const timedOut = (await deps.timedOutJobs?.(head)) ?? [];
    return timedOut.length === 0
      ? null
      : {
          next: "park",
          reason: `CI on head ${head} failed after the converged label was written: ${timedOutWords({ timedOut, recovery: "none" })}, beside ${verdict}; a re-run stops at the same limit, so the drive does not re-run it`,
          labelCaused: false,
        };
  }
  const recovery = await deps.recoverCancelled(
    pr,
    head,
    async () => (await ownershipOf(deps)) === "ours",
  );
  if (recovery === "parked") return { kind: "parked" };
  if (recovery === "listing-cut-short") return { kind: "listing-cut-short" };
  if (isTimedOut(recovery))
    return {
      next: "park",
      reason: `CI on head ${head} failed after the converged label was written: ${timedOutWords(recovery)}; a re-run stops at the same limit, so the drive does not re-run it`,
      labelCaused: false,
    };
  if (recovery !== "none")
    return {
      next: "wait",
      saw: `${verdict} (cancelled-run recovery: ${recoveryLabel(recovery)})`,
    };
  if (verdict.startsWith("cancelled:"))
    return {
      next: "park",
      reason: `required CI on head ${head} reads ${verdict} after the converged label was written, and the cancelled-run recovery found nothing it may re-run`,
      labelCaused: false,
    };
  // A failure only cancelled runs carry, which the recovery leaves: judged as a failure.
  return null;
}

/** One reading of the head's CI and what it asks for. */
async function step(
  pr: string,
  head: string,
  read: CiRead,
  deps: ConvergedCiDeps,
): Promise<Step | ConvergedCiVerdict> {
  const verdict = read.verdict;
  if (verdict === "green" || verdict.startsWith("held:"))
    return { kind: "stands", why: `CI on head ${head} reads ${verdict}` };
  if (verdict.startsWith("pending:") || verdict.startsWith("unknown:"))
    return { next: "wait", saw: verdict };
  const cancelled = await recoverCancelledStep(pr, head, read, deps);
  if (cancelled !== null) return cancelled;
  const judged = await judgeFailure(pr, head, read, deps);
  return judged.next === "rerun" ? rerun(pr, head, judged.runs, deps) : judged;
}

const LOST_WHY =
  "another clone took the drive over, so its CI is not this drive's to change";

/** A park stands only while the drive owns the pull request at the moment it is asked for. */
async function parkOrHold(
  deps: ConvergedCiDeps,
  verdict: ConvergedCiVerdict,
): Promise<ConvergedCiVerdict> {
  if (verdict.kind !== "park") return verdict;
  const owner = await ownershipOf(deps);
  if (owner === "ours") return verdict;
  return owner === "lost"
    ? {
        kind: "stands",
        why: "another clone took the drive over, so a park here would be a stale one",
      }
    : {
        kind: "unverified",
        why: "the drive's ownership did not read, so the park was not recorded",
      };
}

/** How the watch ends when its window is spent, over what its last reading was. */
function windowSpent(
  deps: ConvergedCiDeps,
  verified: string,
  saw: string,
  readOnce: boolean,
  ownershipUnread: boolean,
): ConvergedCiVerdict {
  const minutes = Math.round(deps.windowMs / 60_000);
  if (ownershipUnread)
    return {
      kind: "unverified",
      why: `the drive's ownership did not read within ${minutes} minute(s), so the head's CI was not judged`,
    };
  // A watch that never read the head's CI saw nothing fail: the label stands.
  return readOnce
    ? {
        kind: "park",
        reason: `CI on head ${verified} did not settle within ${minutes} minute(s) of the converged label's write; last read: ${saw}`,
        labelCaused: false,
      }
    : {
        kind: "stands",
        why: `the head's CI did not read within ${minutes} minute(s), so nothing was seen to fail`,
      };
}

/** One poll of the watch: what the head's CI and this drive's ownership ask for. */
async function poll(
  pr: string,
  verified: string,
  deps: ConvergedCiDeps,
): Promise<{
  next: Step | ConvergedCiVerdict;
  read: boolean;
  unread: boolean;
}> {
  const current = await deps.pullRequest(pr);
  if (current !== null && (!current.open || current.head !== verified))
    return {
      next: {
        kind: "stands",
        why: current.open
          ? `the head moved to ${current.head}`
          : "the pull request is no longer open",
      },
      read: false,
      unread: false,
    };
  const owner = await ownershipOf(deps);
  if (owner === "lost")
    return {
      next: { kind: "stands", why: LOST_WHY },
      read: false,
      unread: false,
    };
  if (owner === "unreadable")
    return {
      next: { next: "wait", saw: "the drive's ownership did not read" },
      read: false,
      unread: true,
    };
  const read = current === null ? null : await deps.ci(pr, verified);
  if (read === "listing-cut-short")
    return { next: { kind: "listing-cut-short" }, read: false, unread: false };
  if (read === null)
    return {
      next: { next: "wait", saw: "the pull request or its CI did not read" },
      read: false,
      unread: false,
    };
  return {
    next: await step(pr, verified, read, deps),
    read: true,
    unread: false,
  };
}

/**
 * Watch head `verified` of pull request `pr` from the converged label's write
 * at `writtenAt` until its CI verdict settles, re-running what the write
 * caused once; never throws for a failed read, which waits within the window.
 */
export async function watchConvergedCi(
  pr: string,
  verified: string,
  writtenAt: number,
  deps: ConvergedCiDeps,
): Promise<ConvergedCiVerdict> {
  const deadline = writtenAt + deps.windowMs;
  // Every run the write starts exists once the settle has passed.
  const settle = writtenAt + deps.settleMs - deps.now();
  if (settle > 0) await deps.sleep(settle);
  let saw = "nothing read yet";
  let readOnce = false;
  for (;;) {
    const { next, read, unread } = await poll(pr, verified, deps);
    if ("kind" in next) return parkOrHold(deps, next);
    if (next.next === "park")
      return parkOrHold(deps, {
        kind: "park",
        reason: next.reason,
        labelCaused: next.labelCaused,
      });
    saw = next.saw;
    readOnce ||= read;
    if (deps.now() + deps.pollMs > deadline)
      return parkOrHold(
        deps,
        windowSpent(deps, verified, saw, readOnce, unread),
      );
    await deps.sleep(deps.pollMs);
  }
}
