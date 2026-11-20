/** Escalate a spent exact-head repair budget to one diagnosing pass. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../../../../shared/guards.ts";
import { redactReportText } from "../../../../../shared/closing-report.ts";
import { readBoundedText } from "../../../../../shared/driver-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { shapeOfKey } from "../../../../do-item/scripts/lib/tracker/keys.ts";
import { isGitSha } from "../cli.ts";
import { readPrSnapshot } from "../ci-hold-state.ts";
import {
  diagnosisPrefix,
  diagnosisSkippedPrefix,
  diagnosisStartedPrefix,
  type CiAction,
} from "../state/ci-actions.ts";
import { recordCiAttempt } from "./ci-attempt-record.ts";
import { mirrorNow } from "./ledger.ts";
import { readDriveState } from "./rearm.ts";
import { type RepairCi, runRepairPass } from "./repair.ts";
import type { DriveRoundContext } from "./round-context.ts";
import { driverRuntime } from "./runtime.ts";
import { CI_REPAIR_SPENT_EXIT } from "./settings.ts";

const REPORT_BYTES = 4096;
const DIAGNOSIS_CHARS = 400;
type DiagnosisReport =
  | { staleHead: true }
  | { diagnosis: string; pushedHead: string | undefined };

/** The report supplied by this pass, bounded and read from a regular file. */
function readDiagnosis(path: string): DiagnosisReport | null {
  try {
    const text = readBoundedText(path, REPORT_BYTES);
    const value: unknown = text === null ? null : JSON.parse(text);
    if (
      isRecord(value) &&
      value.staleHead === true &&
      Object.keys(value).length === 1
    )
      return { staleHead: true };
    if (
      !isRecord(value) ||
      typeof value.diagnosis !== "string" ||
      (value.issue !== undefined &&
        (typeof value.issue !== "string" ||
          value.issue.length > 80 ||
          shapeOfKey(value.issue) === null)) ||
      (value.pushedHead !== undefined &&
        (typeof value.pushedHead !== "string" || !isGitSha(value.pushedHead)))
    )
      return null;
    const diagnosis = redactReportText(value.diagnosis)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DIAGNOSIS_CHARS);
    return diagnosis === ""
      ? null
      : {
          diagnosis:
            value.issue === undefined
              ? `no issue filed (parked for a person). ${diagnosis}`
              : `issue ${value.issue}. ${diagnosis}`,
          pushedHead: value.pushedHead,
        };
  } catch (error) {
    swallow(error, "the CI diagnosis report is missing or unreadable");
    return null;
  }
}

/** The last recorded escalation at this head, including an interrupted start. */
function previousDiagnosis(
  actions: readonly CiAction[],
  head: string,
): CiAction | undefined {
  return actions.findLast(
    (a) =>
      a.action === "repair" &&
      (a.detail.startsWith(diagnosisPrefix(head)) ||
        a.detail.startsWith(diagnosisStartedPrefix(head)) ||
        a.detail.startsWith(diagnosisSkippedPrefix(head))),
  );
}

async function reportOutcome(
  pr: string,
  head: string,
  detail: string,
): Promise<boolean> {
  console.error(`  CI diagnosis on head ${head}: ${detail}`);
  return await recordCiAttempt(
    pr,
    "repair",
    `${diagnosisPrefix(head)}${detail}`,
  );
}

async function stopWithDiagnosis(
  pr: string,
  head: string,
  detail: string,
): Promise<number> {
  return (await reportOutcome(pr, head, detail)) ? CI_REPAIR_SPENT_EXIT : 1;
}

export async function diagnosedHeadStop(
  context: DriveRoundContext,
  head: string,
): Promise<number | null> {
  const prior = await readDriveState(context.pr, true);
  if (prior === null) return 1;
  const previous = previousDiagnosis(prior.ciActions ?? [], head);
  if (
    previous === undefined ||
    previous.detail.startsWith(diagnosisSkippedPrefix(head))
  )
    return null;
  if (previous.detail.startsWith(diagnosisStartedPrefix(head)))
    return await stopWithDiagnosis(
      context.pr,
      head,
      "The diagnosing repair was interrupted before it recorded its report.",
    );
  return await stopWithDiagnosis(
    context.pr,
    head,
    previous.detail.slice(diagnosisPrefix(head).length),
  );
}

export async function diagnoseCi(
  context: DriveRoundContext,
  head: string,
  names: string,
  channel: RepairCi,
): Promise<number | "continue"> {
  const dir = mkdtempSync(join(tmpdir(), "jig-ci-diagnosis-"));
  const report = join(dir, "report.json");
  try {
    // Reserve the allowance before spawning so a crash cannot repeat the pass.
    const marked = await recordCiAttempt(
      context.pr,
      "repair",
      `${diagnosisStartedPrefix(head)}CI-repair budget spent for ${names}`,
    );
    if (!marked) return 1;
    const mirrored = await mirrorNow(context.pr, true);
    if (mirrored !== 0) {
      console.error(
        `Could not publish the CI diagnosis reservation (exit ${mirrored}).`,
      );
      await recordCiAttempt(
        context.pr,
        "repair",
        `${diagnosisSkippedPrefix(head)}the reservation could not be published before dispatch`,
      );
      return 1;
    }
    console.error(
      `  Running diagnosing CI repair on head ${head} for ${names}.`,
    );
    const result = await runRepairPass(
      context.agent,
      context.held,
      "ci-diagnose",
      names,
      context.mailboxCheckpoint,
      { ...channel, diagnosisReport: report, diagnosisHead: head },
    );
    if (driverRuntime.compromised !== "") {
      if (
        driverRuntime.passStopWitness !== null &&
        !(await driverRuntime.passStopWitness)
      )
        context.held.length = 0;
      return "continue";
    }
    if (!result.dispatched) {
      await recordCiAttempt(
        context.pr,
        "repair",
        `${diagnosisSkippedPrefix(head)}the pass was not dispatched`,
      );
      return result.resumed ? "continue" : result.code;
    }
    const answer = readDiagnosis(report);
    if (result.postPassMailboxExit !== null) {
      if (answer !== null && !("staleHead" in answer))
        await reportOutcome(
          context.pr,
          head,
          `${answer.diagnosis} The diagnosing pass completed before the mailbox stopped the drive.`,
        );
      return result.postPassMailboxExit;
    }
    if (result.code === 5) return 5;
    if (answer !== null && "staleHead" in answer && result.code === 0) {
      const current = await readPrSnapshot(context.pr, null);
      if (current.ok && current.value.state !== "OPEN") return 5;
      if (current.ok && current.value.head !== head) {
        await recordCiAttempt(
          context.pr,
          "repair",
          `${diagnosisSkippedPrefix(head)}the pull request moved to ${current.value.head}`,
        );
        return "continue";
      }
      return await stopWithDiagnosis(
        context.pr,
        head,
        current.ok
          ? "The diagnosing pass reported a changed head, but the forge still reports the failing head."
          : `The diagnosing pass reported a changed head that could not be verified: ${redactReportText(current.failure.reason)}`,
      );
    }
    if (answer === null || "staleHead" in answer) {
      return await stopWithDiagnosis(
        context.pr,
        head,
        "The diagnosing repair report must contain a diagnosis and, unless filing was parked, a tracker issue key.",
      );
    }
    const { diagnosis, pushedHead } = answer;
    if (result.code !== 0) {
      return await stopWithDiagnosis(
        context.pr,
        head,
        `${diagnosis} (pass exit ${result.code})`,
      );
    }
    if (pushedHead === undefined || pushedHead === head) {
      return await stopWithDiagnosis(
        context.pr,
        head,
        `${diagnosis} The pass reported no replacement head pushed.`,
      );
    }
    const current = await readPrSnapshot(context.pr, null);
    const verified = current.ok && current.value.head === pushedHead;
    const outcome = !current.ok
      ? `The pushed head could not be verified: ${current.failure.reason}`
      : verified
        ? `The pull request moved to ${pushedHead}.`
        : `The pull request is at ${current.value.head}, but the pass reported a push to ${pushedHead}.`;
    const recorded = await reportOutcome(
      context.pr,
      head,
      `${diagnosis} ${redactReportText(outcome)}`,
    );
    if (current.ok && current.value.state !== "OPEN") return 5;
    if (!recorded) return 1;
    return verified ? "continue" : CI_REPAIR_SPENT_EXIT;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
