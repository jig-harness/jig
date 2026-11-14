/** Live reads and mutations for cancellation recovery; every forge call is bounded. */
import {
  observeCancellation,
  claimCancellation,
  readCancellation,
} from "./cancelled-recovery-state.ts";
import { recoverCancelled, type RecoveryDeps } from "./cancelled-recovery.ts";
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

const live: RecoveryDeps = {
  now: currentMs,
  observe: observeCancellation,
  claim: claimCancellation,
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
  rerunnable: rerunnableRuns,
  rerun: (id) => ghCall(["run", "rerun", String(id)]),
  async park(pr, reason) {
    const person = await resolveParkPerson(pr, "cancelled-ci", "finding", "");
    const question = "How should the cancelled workflow recovery continue?";
    const decision: ParkedDecision = {
      schema: "parked-decision/v1",
      class: "human-decision",
      call: {
        id: "a",
        question,
        options: [
          {
            id: "rerun",
            name: "Re-run safely",
            summary:
              "Restart the cancelled workflow after checking its event and permissions.",
            pay: ["Another CI run and a manual check."],
          },
          {
            id: "repair",
            name: "Repair workflow first",
            summary:
              "Fix the concurrency or event configuration before another run.",
            pay: ["A workflow change and delayed merge."],
          },
        ],
        recommended: "rerun",
        why: "Inspect why automatic recovery could not finish; repair the workflow first if its event still carries the hold.",
      },
      steps: [
        reason,
        "Record the result in a pull-request comment and re-arm the drive.",
      ],
      alreadyDone:
        "The drive checked the exact head, workflow replacements and CI hold history, and bounded automatic recovery to one re-run per head. " +
        reason,
    };
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
  if (record?.requestedAt !== null && (record?.workflowIds?.length ?? 0) > 0) {
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
          record?.workflowIds?.includes(run.workflowId) &&
          run.status !== "completed",
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
