/** Live reads and mutations for cancellation recovery; every forge call is bounded. */
import {
  observeCancellation,
  claimCancellation,
  readCancellation,
  releasePendingGrant,
  labelReruns,
  claimLabelRerun,
} from "./cancelled-recovery-state.ts";
import { labelWriteTimes } from "./label-cancelled-runs.ts";
import { readTimeline } from "./pr-timeline.ts";
import {
  recoverCancelled,
  RERUN_OPTION,
  type RecoveryDeps,
} from "./cancelled-recovery.ts";
import { checkRuns } from "./ci-hold-state.ts";
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
import { parsePrSnapshot } from "./ci-hold.ts";
import { workflowRunsFor, withoutSuperseded } from "./status/workflow-runs.ts";
import { currentIso, currentMs } from "../../../../shared/time.ts";

const live: Omit<RecoveryDeps, "rerunnable" | "labelWrites"> = {
  now: currentMs,
  observe: observeCancellation,
  claim: claimCancellation,
  releaseGrant: releasePendingGrant,
  labelReruns,
  claimLabelRerun,
  async confirm(pr, head) {
    const read = await ghCall([
      "pr",
      "view",
      pr,
      "--json",
      "state,headRefOid,labels",
    ]);
    if (read.code !== 0) {
      console.error(
        `cancelled CI recovery: head read exited ${read.code}: ${read.stderr.trim()}`,
      );
      return false;
    }
    try {
      const snapshot = parsePrSnapshot(
        JSON.parse(read.stdout) as unknown,
        holdLabelPolicy(),
      );
      return (
        snapshot !== null &&
        snapshot.state === "OPEN" &&
        snapshot.head === head &&
        !snapshot.held
      );
    } catch (err) {
      swallow(err, "the cancellation recovery head witness is unreadable");
      return false;
    }
  },
  rerun: (id) => ghCall(["run", "rerun", String(id)]),
  async park(pr, reason) {
    const person = await resolveParkPerson(pr, "cancelled-ci", "finding", "");
    const decision = cancelledCiDecision(reason);
    const question = decision.call.question;
    const store = await openStore(pr);
    const capacity = await parkAdmissionContext(pr, store.stateDir);
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

/** A required-check subset at acquisition; all cancelled workflow jobs at final convergence. */
export async function recoverCancelledOnHead(
  pr: string,
  head: string,
  required?: readonly string[],
  alreadyFenced = false,
) {
  const jobs = await checkRuns(head);
  if (jobs === null) {
    console.error(
      "cancelled CI recovery: could not read exact-head check runs",
    );
    return "unknown";
  }
  if (
    !jobs.some(
      (job) =>
        job.status === "completed" &&
        job.conclusion === "cancelled" &&
        (required === undefined || required.includes(job.name)),
    )
  )
    return await waitForRequestedRun(pr, head);
  const snapshot = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,headRefOid,labels",
  ]);
  if (snapshot.code !== 0) {
    console.error(
      `cancelled CI recovery: live hold read exited ${snapshot.code}: ${snapshot.stderr.trim()}`,
    );
    return "unknown";
  }
  try {
    const current = parsePrSnapshot(
      JSON.parse(snapshot.stdout) as unknown,
      holdLabelPolicy(),
    );
    if (current === null || current.state !== "OPEN" || current.head !== head)
      return "unknown";
    // Held synchronize runs cancel deliberately. Their release at convergence,
    // rather than a re-run of the held event, supplies their replacement.
    if (current.held) return "none";
  } catch (err) {
    swallow(
      err,
      "the live CI hold cannot be established for cancellation recovery",
    );
    return "unknown";
  }
  const runs = await workflowRunsFor("{owner}", "{repo}", head);
  if (runs === null) {
    console.error(
      "cancelled CI recovery: could not read exact-head workflow provenance",
    );
    return "unknown";
  }
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
  let lock = null;
  try {
    const context = alreadyFenced
      ? null
      : await resolveFenceContext("cancelled CI recovery");
    lock =
      context === null
        ? null
        : await assertRemoteMutationAllowed(
            context,
            pr,
            "cancelled CI recovery",
          );
  } catch (err) {
    swallow(err, "the cancellation recovery mutation fence is unavailable");
    return "unknown";
  }
  try {
    const answer = await recoverCancelled(pr, head, relevant, runs, {
      ...live,
      ...timelineDeps(pr),
      async rerun(id) {
        if (!(await live.confirm(pr, head)))
          return {
            code: 1,
            stderr: "the pull request closed or its head changed",
          };
        return await live.rerun(id);
      },
    });
    return answer === "none" ? await waitForRequestedRun(pr, head) : answer;
  } finally {
    lock?.dispose();
  }
}

/** A re-run replaces cancelled jobs with pending ones before it supplies results. */
async function waitForRequestedRun(pr: string, head: string) {
  const record = await readCancellation(pr, head);
  const workflowIds =
    record?.requestedAt !== null ? (record?.workflowIds ?? []) : [];
  const labelRuns = new Set(
    [...(await labelReruns(pr)).keys()].map((key) => Number(key.split(":")[0])),
  );
  if (workflowIds.length > 0 || labelRuns.size > 0) {
    const runs = await workflowRunsFor("{owner}", "{repo}", head);
    if (runs === null) {
      console.error(
        "cancelled CI recovery: could not read the requested workflow's progress",
      );
      return "unknown";
    }
    if (
      runs.some(
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
