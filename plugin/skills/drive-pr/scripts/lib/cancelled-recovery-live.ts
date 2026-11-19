/** Live reads and mutations for cancellation recovery; every forge call is bounded. */
import {
  observeCancellation,
  claimCancellation,
  extendCancellation,
  readCancellation,
  releasePendingGrant,
  labelReruns,
  claimLabelRerun,
  withdrawCancellation,
  withdrawLabelRerun,
} from "./cancelled-recovery-state.ts";
import { labelWriteTimes } from "./label-cancelled-runs.ts";
import { readTimeline } from "./pr-timeline.ts";
import {
  recoverCancelled,
  RERUN_OPTION,
  type RecoveryDeps,
} from "./cancelled-recovery.ts";
import {
  type LiveRecovery,
  recoveryRead,
  type RecoveryReadFailure,
} from "./cancelled-recovery-reads.ts";
import { readCheckRuns, readPrSnapshot } from "./ci-hold-state.ts";
import { ghCall } from "./proc.ts";
import { rerunnableRuns } from "./driver/failed-runs.ts";
import { openStore } from "./state/store.ts";
import {
  parkAdmissionContext,
  parkAdmissionProblem,
} from "./state/park-admission.ts";
import { fail } from "./cli.ts";
import type { ParkedDecision } from "../../../../shared/decisions/park.ts";
import { resolveParkPerson } from "./state/park-person.ts";
import {
  assertRemoteMutationAllowed,
  resolveFenceContext,
} from "./state/lease.ts";
import { swallow } from "../../../../shared/errors.ts";
import { holdLabelPolicy } from "./ci-policy.ts";
import { readWorkflowRuns, withoutSuperseded } from "./status/workflow-runs.ts";
import { currentIso, currentMs } from "../../../../shared/time.ts";

/** Thrown by a guarded mutation when the drive passed to another driver; the recovery stands down. */
class OwnershipLost extends Error {
  constructor() {
    super("the drive passed to another driver");
  }
}

const live: Omit<RecoveryDeps, "rerunnable" | "labelWrites" | "park"> & {
  park(
    pr: string,
    reason: string,
    stillOwned?: () => Promise<boolean>,
  ): Promise<void>;
} = {
  now: currentMs,
  observe: observeCancellation,
  claim: claimCancellation,
  extend: extendCancellation,
  releaseGrant: releasePendingGrant,
  labelReruns,
  claimLabelRerun,
  withdrawClaim: withdrawCancellation,
  withdrawLabelRerun,
  confirm: async (pr, head) => {
    const answer = await confirmHead(pr, head);
    return typeof answer === "object" || answer === "unreadable"
      ? "unread"
      : answer;
  },
  rerun: (id) => ghCall(["run", "rerun", String(id)]),
  async park(pr, reason, stillOwned) {
    const person = await resolveParkPerson(pr, "cancelled-ci", "finding", "");
    const decision = cancelledCiDecision(reason);
    const question = decision.call.question;
    const store = await openStore(pr);
    const capacity = await parkAdmissionContext(pr, store.stateDir);
    // Ownership is asked inside the store's lock, after the wait for it, as the
    // write is about to run.
    if (stillOwned !== undefined)
      store.setFence(async () => {
        if (!(await stillOwned())) throw new OwnershipLost();
      });
    await store.update((state) => {
      const next = {
        ...state,
        parked: [
          ...state.parked.filter((p) => p.key !== "cancelled-ci"),
          {
            key: "cancelled-ci",
            kind: "finding" as const,
            reason: question,
            class: "human-decision",
            person,
            decision,
            round: state.rounds,
            at: currentIso(),
          },
        ],
      };
      const admission = parkAdmissionProblem(next, decision, capacity);
      if (admission !== null) fail(2, `park: ${admission}`);
      return next;
    });
  },
};

/**
 * The timeline read once for a recovery poll: the label history and the CI
 * hold's replay check both need it, and it is paginated.
 */
function timelineDeps(
  pr: string,
): Pick<RecoveryDeps, "labelWrites" | "rerunnable"> {
  let read: ReturnType<typeof readTimeline> | undefined;
  const timeline = () => (read ??= readTimeline(pr));
  return {
    rerunnable: (_pr, runs) =>
      rerunnableRuns(pr, runs, async () => {
        const events = await timeline();
        return events.ok ? events.value : null;
      }),
    async labelWrites() {
      const events = await timeline();
      if (!events.ok) {
        console.error(
          `cancelled CI recovery: the label history is unreadable (${events.failure.code}: ${events.failure.reason}); every cancellation counts against the head's re-run`,
        );
        return [];
      }
      let holdLabel: string | null;
      try {
        holdLabel = holdLabelPolicy();
      } catch (err) {
        console.error(
          `cancelled CI recovery: the CI hold label is unreadable (${err instanceof Error ? err.message : String(err)}); every cancellation counts against the head's re-run`,
        );
        return [];
      }
      return labelWriteTimes(events.value, holdLabel);
    },
  };
}

/** The `cancelled-ci` park's framed decision for a recovery that stopped for `reason`. */
export function cancelledCiDecision(reason: string): ParkedDecision {
  return {
    schema: "parked-decision/v1",
    class: "human-decision",
    call: {
      id: "a",
      question: "How should the cancelled workflow recovery continue?",
      options: [
        {
          id: RERUN_OPTION,
          name: "Re-run safely",
          summary:
            "On re-arm, the drive grants this head one more re-run, checks the head and the CI hold again, requests the re-run and waits for its replacement.",
          pay: [
            "Another CI run; a run created under the CI hold still parks again with that reason.",
          ],
        },
        {
          id: "repair",
          name: "Repair workflow first",
          summary:
            "Fix the concurrency or event configuration before another run.",
          pay: ["A workflow change and delayed merge."],
        },
      ],
      recommended: RERUN_OPTION,
      why: "The drive repeats the automatic recovery's checks before it re-runs; repair the workflow first if its runs are still created under the CI hold or its concurrency keeps cancelling the run.",
    },
    steps: [reason, "Answer in a pull-request comment and re-arm the drive."],
    alreadyDone:
      "The drive checked the exact head, workflow replacements and CI hold history, and bounded automatic recovery to one re-run per head. " +
      reason,
  };
}

/** The hold label's policy, or `null` after saying it cannot be read. */
function readableHoldLabel(): { label: string | null } | null {
  try {
    return { label: holdLabelPolicy() };
  } catch (err) {
    swallow(err, "the CI hold label is unreadable for cancellation recovery");
    return null;
  }
}

/** The live pull request as the recovery reads it, or the answer its read failed with. */
async function liveSnapshot(pr: string) {
  const policy = readableHoldLabel();
  if (policy === null)
    return { ok: false as const, answer: "unknown" as const };
  return await recoveryRead("pull request and CI hold", () =>
    readPrSnapshot(pr, policy.label),
  );
}

/**
 * Whether the pull request is open at `head` and not held; the read that failed
 * when waiting could clear it, `unreadable` when it failed another way. A read
 * that failed establishes nothing about the head, so it is never `false`.
 */
async function confirmHead(
  pr: string,
  head: string,
): Promise<boolean | RecoveryReadFailure | "unreadable"> {
  const read = await liveSnapshot(pr);
  if (!read.ok) return read.answer === "unknown" ? "unreadable" : read.answer;
  const { state, head: live, held } = read.value;
  return state === "OPEN" && live === head && !held;
}

/** What the live pull request says of the CI hold: `free` to go on, `none` while held, `unknown` when it cannot be established. */
async function liveHoldState(
  pr: string,
  head: string,
): Promise<"free" | "none" | "unknown" | RecoveryReadFailure> {
  const read = await liveSnapshot(pr);
  if (!read.ok) return read.answer;
  const current = read.value;
  if (current.state !== "OPEN" || current.head !== head) return "unknown";
  // Held synchronize runs cancel deliberately. Their release at convergence,
  // rather than a re-run of the held event, supplies their replacement.
  return current.held ? "none" : "free";
}

/** The recovery's dependencies, each durable claim, forge mutation and park asking `owned` first. */
function fencedDeps(
  pr: string,
  head: string,
  mayMutate: (() => Promise<boolean>) | undefined,
  owned: () => Promise<void>,
  unread: { failure: RecoveryReadFailure | null },
) {
  return {
    ...live,
    ...timelineDeps(pr),
    ...(mayMutate === undefined ? {} : { mayMutate }),
    // The recovery's core answers `unknown` for a head it could not confirm;
    // the read that failed is kept beside it for the answer this module returns.
    async confirm(pr: string, head: string) {
      const answer = await confirmHead(pr, head);
      if (typeof answer === "boolean") return answer;
      if (answer !== "unreadable") unread.failure = answer;
      return "unread" as const;
    },
    async claim(
      pr: string,
      head: string,
      workflowIds: Parameters<typeof claimCancellation>[2],
      requested: Parameters<typeof claimCancellation>[3],
    ) {
      return await claimCancellation(pr, head, workflowIds, requested, owned);
    },
    async extend(
      pr: string,
      head: string,
      earlier: Parameters<typeof extendCancellation>[2],
      requested: Parameters<typeof extendCancellation>[3],
    ) {
      return await extendCancellation(pr, head, earlier, requested, owned);
    },
    async claimLabelRerun(
      pr: string,
      run: Parameters<typeof claimLabelRerun>[1],
    ) {
      return await claimLabelRerun(pr, run, owned);
    },
    async park(parkPr: string, reason: string) {
      await live.park(parkPr, reason, async () => {
        return mayMutate === undefined || (await mayMutate());
      });
    },
    async rerun(id: number) {
      const confirmed = await confirmHead(pr, head);
      if (typeof confirmed !== "boolean") {
        if (confirmed === "unreadable")
          return {
            code: 1,
            stderr: "the pull request could not be read",
            unread: true,
          };
        unread.failure = confirmed;
        return { code: 1, stderr: confirmed.reason, unread: true };
      }
      if (!confirmed)
        return {
          code: 1,
          stderr: "the pull request closed or its head changed",
        };
      // Ownership lost here sends nothing, so the claim goes back unspent.
      try {
        await owned();
      } catch (err) {
        if (!(err instanceof OwnershipLost)) throw err;
        return { code: 1, stderr: err.message, unread: true };
      }
      return await live.rerun(id);
    },
  };
}

/** A required-check subset at acquisition; all cancelled workflow jobs at final convergence. */
export async function recoverCancelledOnHead(
  pr: string,
  head: string,
  required?: readonly string[],
  alreadyFenced = false,
  mayMutate?: () => Promise<boolean>,
): Promise<LiveRecovery> {
  const checks = await recoveryRead("check runs", () => readCheckRuns(head));
  if (!checks.ok) return checks.answer;
  const jobs = checks.value;
  if (
    !jobs.some(
      (job) =>
        job.status === "completed" &&
        job.conclusion === "cancelled" &&
        (required === undefined || required.includes(job.name)),
    )
  )
    return await waitForRequestedRun(pr, head);
  const hold = await liveHoldState(pr, head);
  if (hold !== "free") return hold;
  const provenance = await headWorkflowRuns(head);
  if (!provenance.ok) return provenance.answer;
  const runs = provenance.value;
  // Check runs include external apps, including the reviewer.  Only a job
  // belonging to an Actions workflow can be recovered by `gh run rerun`.
  // Filter after supersession so a newer reviewer/app result still retires
  // its older check before we decide whether a workflow cancellation is
  // orphaned.
  const relevant = withoutSuperseded(jobs, runs).filter(
    (job) =>
      (required === undefined || required.includes(job.name)) &&
      runs.some((run) => run.checkSuiteId === job.suiteId),
  );
  if (relevant.length === 0) return await clearRecoveredPark(pr);
  // The durable claim must not be spent until the mutation fence is held.
  // Otherwise a rival can make this invocation unable to re-run after it has
  // consumed the once-per-head recovery budget.
  const fence = await acquireFence(pr, alreadyFenced);
  if (fence === "unavailable") return "unknown";
  const lock = fence;
  try {
    // A caller that can lose the drive to a successor asks again here, where
    // the first claim is about to be spent.
    if (mayMutate !== undefined && !(await mayMutate())) return "unknown";
    // Every durable claim, forge mutation and park asks again immediately
    // before it commits, after the reads that precede it.
    const owned = async () => {
      if (mayMutate !== undefined && !(await mayMutate()))
        throw new OwnershipLost();
    };
    const unread: { failure: RecoveryReadFailure | null } = { failure: null };
    const answer = await recoverCancelled(
      pr,
      head,
      relevant,
      runs,
      fencedDeps(pr, head, mayMutate, owned, unread),
    );
    if (answer === "unknown" && unread.failure !== null) return unread.failure;
    return answer === "none" ? await waitForRequestedRun(pr, head) : answer;
  } catch (err) {
    if (err instanceof OwnershipLost) return "unknown";
    throw err;
  } finally {
    lock?.dispose();
  }
}

/** The workflow runs on `head`, read as the recovery reads the forge. */
function headWorkflowRuns(head: string) {
  return recoveryRead("workflow runs", () =>
    readWorkflowRuns("{owner}", "{repo}", head),
  );
}

/** The mutation fence for a recovery, `null` when the caller already holds one; "unavailable" when it cannot be had. */
async function acquireFence(pr: string, alreadyFenced: boolean) {
  try {
    const context = alreadyFenced
      ? null
      : await resolveFenceContext("cancelled CI recovery");
    return context === null
      ? null
      : await assertRemoteMutationAllowed(context, pr, "cancelled CI recovery");
  } catch (err) {
    swallow(err, "the cancellation recovery mutation fence is unavailable");
    return "unavailable" as const;
  }
}

/** A re-run replaces cancelled jobs with pending ones before it supplies results. */
async function waitForRequestedRun(
  pr: string,
  head: string,
): Promise<LiveRecovery> {
  const record = await readCancellation(pr, head);
  const workflowIds =
    record?.requestedAt !== null ? (record?.workflowIds ?? []) : [];
  const labelRuns = new Set(
    [...(await labelReruns(pr)).keys()].map((key) => Number(key.split(":")[0])),
  );
  if (workflowIds.length > 0 || labelRuns.size > 0) {
    const progress = await headWorkflowRuns(head);
    if (!progress.ok) return progress.answer;
    if (
      progress.value.some(
        (run) =>
          run.status !== "completed" &&
          (workflowIds.includes(run.workflowId) || labelRuns.has(run.id)),
      )
    )
      return "wait";
  }
  return clearRecoveredPark(pr);
}

async function clearRecoveredPark(pr: string): Promise<"none"> {
  const store = await openStore(pr);
  if (store.read().state.parked.some((p) => p.key === "cancelled-ci"))
    await store.update((state) => ({
      ...state,
      parked: state.parked.filter((p) => p.key !== "cancelled-ci"),
    }));
  return "none";
}
