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
import type { Recovery } from "../cancelled-recovery.ts";
import type { FailedRun, WorkflowRun } from "../status/workflow-runs.ts";

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
  ci(pr: string, head: string): Promise<CiRead | null>;
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
  ): Promise<{ ok: boolean; indeterminate?: boolean; detail: string }>;
  /** The cancelled-run recovery on the head. */
  recoverCancelled(pr: string, head: string): Promise<Recovery>;
}

/**
 * How the watch ended: `stands` leaves the converged stop as it is;
 * `parked` means the cancelled-run recovery parked `cancelled-ci` itself;
 * `park` asks the drive to park with `reason`.
 */
export type ConvergedCiVerdict =
  | { kind: "stands"; why: string }
  | { kind: "parked" }
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
  const now = deps.now();
  const toRerun: WorkflowRun[] = [];
  // The whole collection is judged: a park anywhere ends the watch, a wait
  // is kept while the other runs are examined, and every run a re-run may
  // replay is retried whatever the others are doing.
  let waiting: string | null = null;
  for (const failed of failing) {
    const run = runs.find((r) => r.id === failed.id);
    const judged =
      run === undefined
        ? ({
            next: "wait",
            saw: `${read.verdict} (run ${failed.id} not listed yet)`,
          } as const)
        : judgeRun(run, head, writes, reruns, now);
    if (judged === "rerun" && run !== undefined) toRerun.push(run);
    else if (typeof judged !== "string" && judged.next === "park")
      return judged;
    else if (typeof judged !== "string") waiting ??= judged.saw;
  }
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
): Promise<Step> {
  for (const run of runs) {
    if (!(await deps.claimRerun(pr, run))) continue;
    const asked = await deps.rerunFailed(pr, head, run.id);
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
  const failing = read.failingRuns ?? [];
  const cancelledOnly =
    verdict.startsWith("cancelled:") ||
    (failing.length > 0 &&
      (read.failingStatusNames ?? []).length === 0 &&
      failing.every((r) => r.conclusion === "cancelled"));
  if (cancelledOnly) {
    const recovery = await deps.recoverCancelled(pr, head);
    if (recovery === "parked") return { kind: "parked" };
    if (recovery !== "none")
      return {
        next: "wait",
        saw: `${verdict} (cancelled-run recovery: ${recovery})`,
      };
    if (verdict.startsWith("cancelled:"))
      return {
        next: "park",
        reason: `required CI on head ${head} reads ${verdict} after the converged label was written, and the cancelled-run recovery found nothing it may re-run`,
        labelCaused: false,
      };
    // A failure only cancelled runs carry, which the recovery leaves: judged as a failure.
  }
  const judged = await judgeFailure(pr, head, read, deps);
  return judged.next === "rerun" ? rerun(pr, head, judged.runs, deps) : judged;
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
    const current = await deps.pullRequest(pr);
    if (current !== null && (!current.open || current.head !== verified))
      return {
        kind: "stands",
        why: current.open
          ? `the head moved to ${current.head}`
          : "the pull request is no longer open",
      };
    const read = current === null ? null : await deps.ci(pr, verified);
    const next =
      read === null
        ? {
            next: "wait" as const,
            saw: "the pull request or its CI did not read",
          }
        : await step(pr, verified, read, deps);
    if ("kind" in next) return next;
    if (next.next === "park")
      return {
        kind: "park",
        reason: next.reason,
        labelCaused: next.labelCaused,
      };
    saw = next.saw;
    if (read !== null) readOnce = true;
    if (deps.now() + deps.pollMs > deadline)
      // A watch that never read the head's CI saw nothing fail: the label stands.
      return readOnce
        ? {
            kind: "park",
            reason: `CI on head ${verified} did not settle within ${Math.round(deps.windowMs / 60_000)} minute(s) of the converged label's write; last read: ${saw}`,
            labelCaused: false,
          }
        : {
            kind: "stands",
            why: `the head's CI did not read within ${Math.round(deps.windowMs / 60_000)} minute(s), so nothing was seen to fail`,
          };
    await deps.sleep(deps.pollMs);
  }
}
