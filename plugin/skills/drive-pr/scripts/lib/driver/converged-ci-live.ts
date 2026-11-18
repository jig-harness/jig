/** The converged CI watch's live reads and writes, and the park it ends in; every forge call is bounded. */
import type { ParkedDecision } from "../../../../../shared/decisions/park.ts";
import { swallow } from "../../../../../shared/errors.ts";
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
  watchConvergedCi,
} from "./converged-ci.ts";
import type { DriveLabelWrite } from "./state-labels.ts";
import { rerunnableRuns } from "./failed-runs.ts";
import { FINAL_CI_POLL_SECONDS } from "./settings.ts";

/** The park key a converged head's unsettled CI parks under. */
export const CONVERGED_CI_PARK = "converged-ci";

const WINDOW_MINUTES_DEFAULT = 30;

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
    return snapshot === null
      ? null
      : { open: snapshot.state === "OPEN", head: snapshot.head };
  } catch (err) {
    swallow(err, "the converged CI watch's pull request read is unreadable");
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
    swallow(err, "the CI hold label is unreadable for the converged CI watch");
    return null;
  }
}

/** The watch's live dependencies, its window from `DRIVE_PR_CONVERGED_CI_MINUTES`. */
export function liveConvergedCi(windowMinutes: number): ConvergedCiDeps {
  return {
    now: currentMs,
    sleep: (ms) => sleep(ms / 1000),
    pollMs: FINAL_CI_POLL_SECONDS * 1000,
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
      return { ok: asked.ok, detail: asked.detail };
    },
    recoverCancelled: (pr, head) => recoverCancelledOnHead(pr, head),
  };
}

/** The `converged-ci` park's framed decision for a watch that ended for `reason`. */
export function convergedCiDecision(reason: string): ParkedDecision {
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
      recommended: "repair",
      why: "The runs that left the head unsettled followed the drive's own label write; while the workflows run on every label event, each state write can disturb CI again.",
    },
    steps: [reason, "Answer in a pull-request comment and re-arm the drive."],
    alreadyDone:
      "The drive converged and certified CI on this head, wrote the converged label, then watched the head's CI, re-ran each cancellation and each failure a label write started once, and parked when that did not bring it back to green. " +
      reason,
  };
}

/** Record the `converged-ci` park in the drive state; false when the park could not be admitted. */
export async function parkConvergedCi(
  pr: string,
  reason: string,
): Promise<boolean> {
  try {
    const person = await resolveParkPerson(
      pr,
      CONVERGED_CI_PARK,
      "finding",
      "",
    );
    const decision = convergedCiDecision(reason);
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
    console.error(
      `converged CI: the park was not recorded: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** The watch the stop runs after its `converged` label write: the head, and when the write was made. */
export type ConvergedRecheck = (
  pr: string,
  verified: string,
  writtenAt: number,
) => Promise<ConvergedCiVerdict>;

/** The live watch, over the window `DRIVE_PR_CONVERGED_CI_MINUTES` sets; `0` watches nothing. */
export const liveRecheck: ConvergedRecheck = async (
  pr,
  verified,
  writtenAt,
) => {
  const minutes = convergedCiMinutes();
  if (minutes === 0)
    return { kind: "stands", why: "DRIVE_PR_CONVERGED_CI_MINUTES is 0" };
  console.error(
    `converged CI: watching head ${verified} for up to ${minutes} minute(s) after the converged label's write, which can start CI on it`,
  );
  return watchConvergedCi(pr, verified, writtenAt, liveConvergedCi(minutes));
};

/**
 * After a stop's label write: when it wrote `converged`, watch the head's CI
 * and say whether the stop must be settled again as a park, recording the
 * `converged-ci` park when the watch asks for one. Never throws: a defect is
 * reported and the converged stop stands.
 */
export async function convergedStopParks(
  pr: string,
  labelled: DriveLabelWrite | null,
  writtenAt: number,
  recheck: ConvergedRecheck,
): Promise<boolean> {
  if (
    labelled === null ||
    !labelled.converged ||
    labelled.write.outcome !== "written" ||
    !("stopped" in labelled.moment)
  )
    return false;
  try {
    const verdict = await recheck(pr, labelled.moment.verifiedSha, writtenAt);
    if (verdict.kind === "stands") {
      console.error(`converged CI: the converged label stands: ${verdict.why}`);
      return false;
    }
    if (verdict.kind === "park") {
      console.error(`converged CI: parking: ${verdict.reason}`);
      await parkConvergedCi(pr, verdict.reason);
    } else
      console.error(
        "converged CI: the cancelled-run recovery parked cancelled-ci",
      );
    return true;
  } catch (err) {
    console.error(
      `converged CI: the watch failed, so the converged label stands: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return false;
  }
}
