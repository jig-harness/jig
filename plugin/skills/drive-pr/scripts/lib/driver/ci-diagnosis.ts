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
  lastDiagnosisAt,
} from "../state/ci-actions.ts";
import { recordCiAttempt } from "./ci-attempt-record.ts";
import { afterTakeover } from "./ci-repair-pass.ts";
import { mirrorNow } from "./ledger.ts";
import { readDriveState } from "./rearm.ts";
import { type RepairCi, runRepairPass } from "./repair.ts";
import type { DriveRoundContext } from "./round-context.ts";
import { driverRuntime } from "./runtime.ts";
import { CI_REPAIR_SPENT_EXIT } from "./settings.ts";
import { HUMAN_DECISION_CLASS } from "../state/rulings.ts";
import { parseMs } from "../../../../../shared/time.ts";

const REPORT_BYTES = 4096;
const DIAGNOSIS_CHARS = 400;
const PARK_KEY_CHARS = 200;
type DiagnosisReport =
  | { staleHead: true }
  | { standDown: true }
  | {
      diagnosis: string;
      issue: string | undefined;
      parked: string | undefined;
      pushedHead: string | undefined;
    };

/** A park key as `drive-state.ts park` accepts one, bounded for the receipt. */
function isParkKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= PARK_KEY_CHARS &&
    !/[\n\r]/.test(value)
  );
}

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
      isRecord(value) &&
      value.standDown === true &&
      Object.keys(value).length === 1
    )
      return { standDown: true };
    if (
      !isRecord(value) ||
      typeof value.diagnosis !== "string" ||
      // Exactly one of a filed issue's key or the key of the parked filing.
      (value.issue === undefined) === (value.parked === undefined) ||
      (value.issue !== undefined &&
        (typeof value.issue !== "string" ||
          value.issue.length > 80 ||
          shapeOfKey(value.issue) === null)) ||
      (value.parked !== undefined && !isParkKey(value.parked)) ||
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
          diagnosis,
          issue: value.issue as string | undefined,
          parked: value.parked as string | undefined,
          pushedHead: value.pushedHead,
        };
  } catch (error) {
    swallow(error, "the CI diagnosis report is missing or unreadable");
    return null;
  }
}

const INCOMPLETE =
  "The diagnosing repair report must contain a diagnosis and either a tracker issue key or the key of the filing it parked.";

/** A receipt the driver accepted, a refused one, or a report of a moved head. */
type Receipt =
  | { text: string; pushedHead: string | undefined }
  | { refused: string }
  | { staleHead: true }
  | { standDown: true };

/**
 * Judge the pass's receipt. Its diagnosis is prefixed with the tracker issue,
 * or with the filing the pass parked: a receipt that names no issue is
 * accepted only when the drive state holds a `human-decision` park of the key
 * it names, recorded after this diagnosis was reserved.
 */
async function judgeReceipt(
  pr: string,
  head: string,
  answer: DiagnosisReport | null,
): Promise<Receipt> {
  if (answer === null) return { refused: INCOMPLETE };
  if ("staleHead" in answer || "standDown" in answer) return answer;
  const { diagnosis, pushedHead } = answer;
  if (answer.issue !== undefined)
    return { text: `issue ${answer.issue}. ${diagnosis}`, pushedHead };
  const state = await readDriveState(pr, true);
  if (state === null)
    return {
      refused:
        "The diagnosing repair report names a parked filing, but the drive state could not be read to verify it.",
    };
  const started = state.ciActions?.findLast(
    (a) =>
      a.action === "repair" &&
      a.detail.startsWith(diagnosisStartedPrefix(head)),
  );
  const since = started === undefined ? Number.NaN : parseMs(started.at);
  const parked = state.parked.some(
    (p) =>
      p.key === answer.parked &&
      p.class === HUMAN_DECISION_CLASS &&
      parseMs(p.at ?? "") >= since,
  );
  return parked
    ? { text: `no issue filed (parked for a person). ${diagnosis}`, pushedHead }
    : {
        refused: `The diagnosing repair report names the filing park ${redactReportText(answer.parked ?? "")}, but this diagnosis parked no ${HUMAN_DECISION_CLASS} under that key; it must name a tracker issue key or a filing parked during this diagnosis.`,
      };
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
  const previous = lastDiagnosisAt(prior.ciActions ?? [], head);
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

/**
 * Reserve the one diagnosis this head is allowed, before spawning, so a crash
 * cannot repeat the pass; `false` when the reservation could not be recorded
 * and published.
 */
async function reserveDiagnosis(
  pr: string,
  head: string,
  names: string,
): Promise<boolean> {
  const marked = await recordCiAttempt(
    pr,
    "repair",
    `${diagnosisStartedPrefix(head)}CI-repair budget spent for ${names}`,
  );
  if (!marked) return false;
  const mirrored = await mirrorNow(pr, true);
  if (mirrored === 0) return true;
  console.error(
    `Could not publish the CI diagnosis reservation (exit ${mirrored}).`,
  );
  await recordCiAttempt(
    pr,
    "repair",
    `${diagnosisSkippedPrefix(head)}the reservation could not be published before dispatch`,
  );
  return false;
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
    if (!(await reserveDiagnosis(context.pr, head, names))) return 1;
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
    if (driverRuntime.compromised !== "") return await afterTakeover(context);
    if (!result.dispatched) {
      await recordCiAttempt(
        context.pr,
        "repair",
        `${diagnosisSkippedPrefix(head)}the pass was not dispatched`,
      );
      return result.resumed ? "continue" : result.code;
    }
    const receipt = await judgeReceipt(context.pr, head, readDiagnosis(report));
    return await settleDiagnosis(context.pr, head, result, receipt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The drive's next step once the diagnosing pass ran and left `receipt`. */
async function settleDiagnosis(
  pr: string,
  head: string,
  result: { code: number; postPassMailboxExit: number | null },
  receipt: Receipt,
): Promise<number | "continue"> {
  if (result.postPassMailboxExit !== null) {
    if ("text" in receipt)
      await reportOutcome(
        pr,
        head,
        `${receipt.text} The diagnosing pass completed before the mailbox stopped the drive.`,
      );
    return result.postPassMailboxExit;
  }
  if (result.code === 5) return 5;
  if ("staleHead" in receipt)
    return result.code === 0
      ? await staleHeadOutcome(pr, head)
      : await stopWithDiagnosis(pr, head, INCOMPLETE);
  if ("standDown" in receipt)
    return result.code === 0
      ? await standDownOutcome(pr, head)
      : await stopWithDiagnosis(pr, head, INCOMPLETE);
  if ("refused" in receipt)
    return await stopWithDiagnosis(pr, head, receipt.refused);
  if (result.code !== 0)
    return await stopWithDiagnosis(
      pr,
      head,
      `${receipt.text} (pass exit ${result.code})`,
    );
  return await pushedHeadOutcome(pr, head, receipt.text, receipt.pushedHead);
}

/**
 * The pass's fresh gate no longer matched the dispatched task (a new finding
 * made the head `ROUND_READY`): release the reservation without spending the
 * head's diagnosis, and let the driver's next gate decide what runs.
 */
async function standDownOutcome(
  pr: string,
  head: string,
): Promise<number | "continue"> {
  const recorded = await recordCiAttempt(
    pr,
    "repair",
    `${diagnosisSkippedPrefix(head)}the pass stood down: its gate no longer matched the task`,
  );
  return recorded ? "continue" : 1;
}

/** The pass reported that the pull request left the failing head. */
async function staleHeadOutcome(
  pr: string,
  head: string,
): Promise<number | "continue"> {
  const current = await readPrSnapshot(pr, null);
  if (current.ok && current.value.state !== "OPEN") return 5;
  if (current.ok && current.value.head !== head) {
    await recordCiAttempt(
      pr,
      "repair",
      `${diagnosisSkippedPrefix(head)}the pull request moved to ${current.value.head}`,
    );
    return "continue";
  }
  return await stopWithDiagnosis(
    pr,
    head,
    current.ok
      ? "The diagnosing pass reported a changed head, but the forge still reports the failing head."
      : `The diagnosing pass reported a changed head that could not be verified: ${redactReportText(current.failure.reason)}`,
  );
}

/** Record the accepted diagnosis beside what the forge says of its push. */
async function pushedHeadOutcome(
  pr: string,
  head: string,
  diagnosis: string,
  pushedHead: string | undefined,
): Promise<number | "continue"> {
  if (pushedHead === undefined || pushedHead === head)
    return await stopWithDiagnosis(
      pr,
      head,
      `${diagnosis} The pass reported no replacement head pushed.`,
    );
  const current = await readPrSnapshot(pr, null);
  const verified = current.ok && current.value.head === pushedHead;
  const outcome = !current.ok
    ? `The pushed head could not be verified: ${current.failure.reason}`
    : verified
      ? `The pull request moved to ${pushedHead}.`
      : `The pull request is at ${current.value.head}, but the pass reported a push to ${pushedHead}.`;
  const recorded = await reportOutcome(
    pr,
    head,
    `${diagnosis} ${redactReportText(outcome)}`,
  );
  if (current.ok && current.value.state !== "OPEN") return 5;
  if (!recorded) return 1;
  return verified ? "continue" : CI_REPAIR_SPENT_EXIT;
}
