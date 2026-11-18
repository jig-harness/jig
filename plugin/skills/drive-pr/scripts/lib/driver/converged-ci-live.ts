/** The converged CI watch's live reads and writes, and the park it ends in; every forge call is bounded. */
import type { ParkedDecision } from "../../../../../shared/decisions/park.ts";
import { currentIso, currentMs } from "../../../../../shared/time.ts";
import { recoverCancelledOnHead } from "../cancelled-recovery-live.ts";
import { claimLabelRerun, labelReruns } from "../cancelled-recovery-state.ts";
import { parsePrSnapshot } from "../ci-hold.ts";
import { holdLabelPolicy } from "../ci-policy.ts";
import { sleep, testPacing } from "../cli.ts";
import { LABEL_SETTLE_MS, labelWriteTimes } from "../label-cancelled-runs.ts";
import { readTimeline } from "../pr-timeline.ts";
import { ghCall } from "../proc.ts";
import { checkRunsFor, ciReportFor } from "../status/evidence.ts";
import { workflowRunsFor } from "../status/workflow-runs.ts";
import {
  parkAdmissionContext,
  parkAdmissionProblem,
} from "../state/park-admission.ts";
import { resolveParkPerson } from "../state/park-person.ts";
import { openStore } from "../state/store.ts";
import { failedCheckForge } from "./ci-retry-forge.ts";
import {
  type ConvergedCiDeps,
  type ConvergedCiVerdict,
  type Ownership,
  watchConvergedCi,
} from "./converged-ci.ts";
import type { DriveLabelWrite } from "./state-labels.ts";
import { rerunnableRuns } from "./failed-runs.ts";
import { DRIVE_EXIT } from "../status/terminal-states.ts";

/** The park key a converged head's unsettled CI parks under. */
export const CONVERGED_CI_PARK = "converged-ci";

const WINDOW_MINUTES_DEFAULT = 30;

/** How often the watch reads the head's CI: a read costs a handful of forge requests. */
const POLL_MS = 30_000;

/**
 * How long the watch waits for the converged head's CI to settle, in minutes:
 * `DRIVE_PR_CONVERGED_CI_MINUTES`, `0` to write the label and not watch.
 */
export function convergedCiMinutes(
  raw: string | undefined = process.env.DRIVE_PR_CONVERGED_CI_MINUTES,
): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return WINDOW_MINUTES_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : WINDOW_MINUTES_DEFAULT;
}

async function pullRequest(pr: string) {
  const read = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,headRefOid,labels",
  ]);
  if (read.code !== 0) {
    console.error(
      `converged CI: the pull request did not read (exit ${read.code}): ${read.stderr.trim()}`,
    );
    return null;
  }
  try {
    const snapshot = parsePrSnapshot(
      JSON.parse(read.stdout) as unknown,
      holdLabelPolicy(),
    );
    if (snapshot === null)
      console.error("converged CI: the pull request read has no state or head");
    return snapshot === null
      ? null
      : { open: snapshot.state === "OPEN", head: snapshot.head };
  } catch (err) {
    console.error(
      `converged CI: the pull request or the CI hold setting did not read: ${described(err)}`,
    );
    return null;
  }
}

async function ci(pr: string, head: string) {
  const runs = await checkRunsFor("{owner}", "{repo}", head);
  if (runs === null) return null;
  const report = await ciReportFor("{owner}", "{repo}", head, runs, false, pr);
  return {
    verdict: report.ci,
    failingRuns: report.failingRuns,
    failingStatusNames: report.failingStatusNames,
  };
}

async function labelWrites(pr: string): Promise<number[] | null> {
  const events = await readTimeline(pr);
  if (!events.ok) {
    console.error(
      `converged CI: the label history did not read (${events.failure.code}: ${events.failure.reason})`,
    );
    return null;
  }
  try {
    return labelWriteTimes(events.value, holdLabelPolicy());
  } catch (err) {
    console.error(
      `converged CI: the CI hold setting did not read: ${described(err)}`,
    );
    return null;
  }
}

/** The watch's live dependencies, its window from `DRIVE_PR_CONVERGED_CI_MINUTES`. */
export function liveConvergedCi(windowMinutes: number): ConvergedCiDeps {
  return {
    now: currentMs,
    sleep: (ms) => sleep(ms / 1000),
    pollMs: testPacing("DRIVE_PR_CONVERGED_CI_POLL_MS", POLL_MS, 10),
    settleMs: testPacing(
      "DRIVE_PR_CONVERGED_CI_SETTLE_MS",
      LABEL_SETTLE_MS,
      10,
    ),
    windowMs: windowMinutes * 60_000,
    pullRequest,
    ci,
    workflowRuns: (head) => workflowRunsFor("{owner}", "{repo}", head),
    labelWrites,
    labelReruns,
    rerunnable: (pr, runs) => rerunnableRuns(pr, runs),
    claimRerun: claimLabelRerun,
    async rerunFailed(pr, head, run) {
      const asked = await failedCheckForge.retry(pr, head, run);
      return {
        ok: asked.ok,
        detail: asked.detail,
        ...(asked.indeterminate === true ? { indeterminate: true } : {}),
      };
    },
    recoverCancelled: (pr, head, mayMutate) =>
      recoverCancelledOnHead(pr, head, undefined, false, mayMutate),
  };
}

/** The `converged-ci` park's framed decision for a watch that ended for `reason`. */
export function convergedCiDecision(
  reason: string,
  labelCaused: boolean,
): ParkedDecision {
  return {
    schema: "parked-decision/v1",
    class: "human-decision",
    call: {
      id: "a",
      question:
        "How should the converged head's CI, disturbed after the converged label was written, be settled?",
      options: [
        {
          id: "repair",
          name: "Repair the label triggers",
          summary:
            "Make the workflows start no run for a label event whose label is not the CI hold's, then re-run the named runs and re-arm the drive.",
          pay: ["A workflow change before the merge."],
        },
        {
          id: "rearm",
          name: "Re-arm the drive",
          summary:
            "The re-armed drive reads the head's CI again and retries or repairs what still fails, as on any converged head.",
          pay: [
            "Another drive; its own state-label writes start the same workflows again.",
          ],
        },
      ],
      recommended: labelCaused ? "repair" : "rearm",
      why: labelCaused
        ? "The runs that left the head unsettled were started by the drive's own label write; while the workflows run on every label event, each state write can disturb CI again."
        : "The reason below names no failure the drive's label write started (a commit status, an unattributed run, or CI still unsettled), so repairing the label triggers is not shown to help; a re-armed drive reads the head's CI afresh. Choose the repair if you know the label write caused it.",
    },
    steps: [reason, "Answer in a pull-request comment and re-arm the drive."],
    alreadyDone:
      "The drive converged and certified CI on this head, wrote the converged label, then watched the head's CI. It re-runs a cancellation or a failure once only where a label write started the run, and parks otherwise; the reason says which happened. " +
      reason,
  };
}

/** Record the `converged-ci` park in the drive state; false when the park could not be admitted. */
export async function parkConvergedCi(
  pr: string,
  reason: string,
  labelCaused: boolean,
): Promise<boolean> {
  try {
    const person = await resolveParkPerson(
      pr,
      CONVERGED_CI_PARK,
      "finding",
      "",
    );
    const decision = convergedCiDecision(reason, labelCaused);
    const store = await openStore(pr);
    const capacity = await parkAdmissionContext(pr, store.stateDir);
    let admitted = true;
    await store.update((state) => {
      const next = {
        ...state,
        parked: [
          ...state.parked.filter((p) => p.key !== CONVERGED_CI_PARK),
          {
            key: CONVERGED_CI_PARK,
            kind: "finding" as const,
            reason: decision.call.question,
            class: "human-decision",
            person,
            decision,
            round: state.rounds,
            at: currentIso(),
          },
        ],
      };
      const problem = parkAdmissionProblem(next, decision, capacity);
      if (problem === null) return next;
      console.error(`converged CI: the park was not admitted: ${problem}`);
      admitted = false;
      return state;
    });
    return admitted;
  } catch (err) {
    console.error(`converged CI: the park was not recorded: ${described(err)}`);
    return false;
  }
}

/** The watch the stop runs after its `converged` label write: the head, and when the write was made. */
export type ConvergedRecheck = (
  pr: string,
  verified: string,
  writtenAt: number,
  owned?: () => Promise<Ownership>,
) => Promise<ConvergedCiVerdict>;

/** The live watch, over the window `DRIVE_PR_CONVERGED_CI_MINUTES` sets; `0` watches nothing. */
export const liveRecheck: ConvergedRecheck = async (
  pr,
  verified,
  writtenAt,
  owned,
) => {
  const minutes = convergedCiMinutes();
  if (minutes === 0)
    return { kind: "stands", why: "DRIVE_PR_CONVERGED_CI_MINUTES is 0" };
  console.error(
    `converged CI: watching head ${verified} for up to ${minutes} minute(s) after the converged label's write, which can start CI on it`,
  );
  return watchConvergedCi(pr, verified, writtenAt, {
    ...liveConvergedCi(minutes),
    ...(owned === undefined ? {} : { owned }),
  });
};

/** What a defect or a throw says, with its stack where it has one. */
function described(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * After a stop's label write: when it wrote `converged`, watch the head's CI
 * and return the exit the stop must be settled again with, or `null` when
 * the converged stop stands. A park the watch asks for is `HITL_PARKED` only
 * once its `converged-ci` record is in the drive state (or the cancelled-run
 * recovery recorded `cancelled-ci`); a park that could not be recorded, or a
 * watch that failed, is `INDETERMINATE`, a stop the dispatcher drives again,
 * since the label must not say `converged` over CI nobody settled. Never
 * throws.
 */
export async function convergedStopExit(
  pr: string,
  labelled: DriveLabelWrite | null,
  writtenAt: number,
  recheck: ConvergedRecheck,
  owned?: () => Promise<Ownership>,
): Promise<number | null> {
  if (
    labelled === null ||
    !labelled.converged ||
    labelled.write.outcome !== "written" ||
    !("stopped" in labelled.moment)
  )
    return null;
  try {
    const verdict = await recheck(
      pr,
      labelled.moment.verifiedSha,
      writtenAt,
      owned,
    );
    if (verdict.kind === "stands") {
      console.error(`converged CI: the converged label stands: ${verdict.why}`);
      return null;
    }
    if (verdict.kind === "unverified") {
      console.error(
        `converged CI: ${verdict.why}, so the stop is settled as INDETERMINATE for the next drive to judge the head again`,
      );
      return DRIVE_EXIT.INDETERMINATE;
    }
    if (verdict.kind === "parked") {
      console.error(
        "converged CI: the cancelled-run recovery parked cancelled-ci",
      );
      return DRIVE_EXIT.HITL_PARKED;
    }
    console.error(`converged CI: parking: ${verdict.reason}`);
    if (await parkConvergedCi(pr, verdict.reason, verdict.labelCaused))
      return DRIVE_EXIT.HITL_PARKED;
    console.error(
      "converged CI: the park could not be recorded, so the stop is settled as INDETERMINATE for the next drive to judge the head again",
    );
    return DRIVE_EXIT.INDETERMINATE;
  } catch (err) {
    console.error(
      `converged CI: the watch failed, so the stop is settled as INDETERMINATE for the next drive to judge the head again: ${described(err)}`,
    );
    return DRIVE_EXIT.INDETERMINATE;
  }
}
