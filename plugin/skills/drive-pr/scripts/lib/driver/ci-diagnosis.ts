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
  parkKeySurvivesStorage,
  parkTag,
  splitParkTag,
} from "../state/ci-actions.ts";
import { DRIVE_EXIT } from "../status/terminal-states.ts";
import { recordCiAttempt } from "./ci-attempt-record.ts";
import { afterTakeover } from "./ci-repair-pass.ts";
import { mirrorNow } from "./ledger.ts";
import { threadComments } from "./park-answers.ts";
import { readDriveState } from "./rearm.ts";
import { type RepairCi, runRepairPass } from "./repair.ts";
import type { DriveRoundContext } from "./round-context.ts";
import { driverRuntime } from "./runtime.ts";
import { CI_REPAIR_SPENT_EXIT } from "./settings.ts";
import type { DriveState } from "../state/schema.ts";

const REPORT_BYTES = 4096;
const DIAGNOSIS_CHARS = 400;
const PARK_KEY_CHARS = 200;
export type DiagnosisReport =
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
    !/[\n\r]/.test(value) &&
    parkKeySurvivesStorage(value)
  );
}

/** A one-key marker report such as `{"standDown": true}`. */
const isMarker = (value: unknown, key: string): boolean =>
  isRecord(value) && value[key] === true && Object.keys(value).length === 1;

/** Whether a receipt names exactly one well-formed issue or park key. */
function namesIssueOrPark(value: Record<string, unknown>): boolean {
  if ((value.issue === undefined) === (value.parked === undefined))
    return false;
  if (value.issue !== undefined)
    return (
      typeof value.issue === "string" &&
      value.issue.length <= 80 &&
      shapeOfKey(value.issue) !== null
    );
  return isParkKey(value.parked);
}

/** The full receipt: a diagnosis, its issue or park, and an optional pushed head. */
function fullReport(value: unknown): DiagnosisReport | null {
  if (
    !isRecord(value) ||
    typeof value.diagnosis !== "string" ||
    !namesIssueOrPark(value) ||
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
}

/** The report supplied by this pass, bounded and read from a regular file. */
export function readDiagnosis(path: string): DiagnosisReport | null {
  try {
    const text = readBoundedText(path, REPORT_BYTES);
    const value: unknown = text === null ? null : JSON.parse(text);
    if (isMarker(value, "staleHead")) return { staleHead: true };
    if (isMarker(value, "standDown")) return { standDown: true };
    return fullReport(value);
  } catch (error) {
    swallow(error, "the CI diagnosis report is missing or unreadable");
    return null;
  }
}

const STOOD_DOWN = "the pass stood down: its gate no longer matched the task";
/** Stand-downs one head may take before the drive stops instead of redispatching. */
const STAND_DOWN_LIMIT = 2;

/**
 * The count leads the free-form detail, right after the receipt's own prefix,
 * so the detail's 1024-character bound can never cut it and no check name
 * after it can imitate it.
 */
const STAND_DOWN_COUNT = /^\[stood down (\d+)x\] /;
const standDownTag = (n: number) => (n > 0 ? `[stood down ${n}x] ` : "");

/** A skipped receipt for `head` that keeps the stand-downs already taken. */
async function recordSkipped(
  pr: string,
  head: string,
  text: string,
  taken?: number,
): Promise<boolean> {
  const count = taken ?? (await standDownsAt(pr, head));
  if (count === null) return false;
  return await recordCiAttempt(
    pr,
    "repair",
    `${diagnosisSkippedPrefix(head)}${standDownTag(count)}${text}`,
  );
}

/**
 * Stand-downs already taken on `head`. Only the latest receipt per head is
 * kept, so the count rides in that receipt and each reservation carries it on.
 */
async function standDownsAt(pr: string, head: string): Promise<number | null> {
  const state = await readDriveState(pr, true);
  if (state === null) return null;
  const last = lastDiagnosisAt(state.ciActions ?? [], head);
  const prefix = last?.detail.startsWith(diagnosisSkippedPrefix(head))
    ? diagnosisSkippedPrefix(head)
    : diagnosisStartedPrefix(head);
  const rest = (last?.detail ?? "").slice(prefix.length);
  return Number(STAND_DOWN_COUNT.exec(rest)?.[1] ?? 0);
}

const INCOMPLETE =
  "The diagnosing repair report must contain a diagnosis and either a tracker issue key or an open park key.";

/** A receipt the driver accepted, a refused one, or a report of a moved head. */
export type Receipt =
  | { text: string; pushedHead: string | undefined; parked: boolean }
  | { refused: string }
  | { staleHead: true }
  | { standDown: true };

/**
 * Judge the pass's receipt against the current parked set. A park can be
 * recorded before the diagnosis and still block the repair. `readState`
 * reads the drive state, `drive-state.ts get` by default.
 */
export async function judgeReceipt(
  pr: string,
  answer: DiagnosisReport | null,
  readState: (pr: string) => Promise<DriveState | null> = (p) =>
    readDriveState(p, true),
  threadOpen: (key: string) => Promise<boolean | null> = async (key) => {
    const thread = await threadComments(key);
    return thread?.isResolved == null ? null : !thread.isResolved;
  },
): Promise<Receipt> {
  if (answer === null) return { refused: INCOMPLETE };
  if ("staleHead" in answer || "standDown" in answer) return answer;
  const { diagnosis, pushedHead } = answer;
  if (answer.issue !== undefined)
    return {
      text: `issue ${answer.issue}. ${diagnosis}`,
      pushedHead,
      parked: false,
    };
  const state = await readState(pr);
  if (state === null)
    return {
      refused:
        "The diagnosing repair report names an open park, but the drive state could not be read to verify it.",
    };
  const park = state.parked.find((p) => p.key === answer.parked);
  // A review thread's park can outlive its thread: it stands for the decision
  // only while the forge reports the thread open.
  const open =
    park === undefined
      ? false
      : park.kind === "thread"
        ? await threadOpen(park.key)
        : true;
  if (open === true)
    return {
      text: `${parkTag(answer.parked ?? "")}no issue filed (parked for a person). ${diagnosis}`,
      pushedHead,
      parked: true,
    };
  return {
    refused:
      open === null
        ? `The diagnosing repair report names park ${redactReportText(answer.parked ?? "")}, a review thread whose state could not be read.`
        : `The diagnosing repair report names park ${redactReportText(answer.parked ?? "")}, but that key is not open in the drive's parked set.`,
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
  const recorded = previous.detail.slice(diagnosisPrefix(head).length);
  // A diagnosis that handed the head to a person ends with that park: once
  // an answer has removed it, the repair they decided is owed on this head.
  const { key } = splitParkTag(recorded);
  if (key !== null && !prior.parked.some((p) => p.key === key)) return null;
  return await stopWithDiagnosis(context.pr, head, recorded);
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
  const stoodDown = await standDownsAt(pr, head);
  if (stoodDown === null) return false;
  const marked = await recordCiAttempt(
    pr,
    "repair",
    `${diagnosisStartedPrefix(head)}${standDownTag(stoodDown)}CI-repair budget spent for ${names}`,
  );
  if (!marked) return false;
  const mirrored = await mirrorNow(pr, true);
  if (mirrored === 0) return true;
  console.error(
    `Could not publish the CI diagnosis reservation (exit ${mirrored}).`,
  );
  await recordSkipped(
    pr,
    head,
    "the reservation could not be published before dispatch",
    stoodDown,
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
      const recorded = await recordSkipped(
        context.pr,
        head,
        "the pass was not dispatched",
      );
      if (!recorded) return result.resumed ? 1 : result.code;
      return result.resumed ? "continue" : result.code;
    }
    const receipt = await judgeReceipt(context.pr, readDiagnosis(report));
    return await settleDiagnosis(context.pr, head, result, receipt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The mailbox stopped the drive while the diagnosing pass ran: keep what it left. */
async function settleMailboxExit(
  pr: string,
  head: string,
  exit: number,
  receipt: Receipt,
): Promise<number> {
  if ("standDown" in receipt) {
    const taken = await standDownsAt(pr, head);
    if (taken !== null) await recordSkipped(pr, head, STOOD_DOWN, taken + 1);
  }
  if ("text" in receipt)
    await reportOutcome(
      pr,
      head,
      `${receipt.text} The diagnosing pass completed before the mailbox stopped the drive.`,
    );
  return exit;
}

/** The step for a receipt that carries no diagnosis, or null when it carries one. */
async function settleUndiagnosed(
  pr: string,
  head: string,
  code: number,
  receipt: Receipt,
): Promise<number | "continue" | null> {
  if ("refused" in receipt)
    return await stopWithDiagnosis(pr, head, receipt.refused);
  const next = "staleHead" in receipt ? staleHeadOutcome : standDownOutcome;
  if ("staleHead" in receipt || "standDown" in receipt)
    return code === 0
      ? await next(pr, head)
      : await stopWithDiagnosis(pr, head, INCOMPLETE);
  return null;
}

/** The drive's next step once the diagnosing pass ran and left `receipt`. */
async function settleDiagnosis(
  pr: string,
  head: string,
  result: { code: number; postPassMailboxExit: number | null },
  receipt: Receipt,
): Promise<number | "continue"> {
  if (result.postPassMailboxExit !== null)
    return await settleMailboxExit(
      pr,
      head,
      result.postPassMailboxExit,
      receipt,
    );
  if (result.code === 5) return 5;
  const undiagnosed = await settleUndiagnosed(pr, head, result.code, receipt);
  if (undiagnosed !== null || !("text" in receipt)) return undiagnosed ?? 1;
  const replaced =
    receipt.pushedHead !== undefined && receipt.pushedHead !== head;
  if (result.code !== 0 && !replaced) {
    const detail = `${receipt.text} (pass exit ${result.code}; no replacement head pushed)`;
    if (!receipt.parked) return await stopWithDiagnosis(pr, head, detail);
    // The decision the receipt names stays open: hand it back, not a failure.
    return (await reportOutcome(pr, head, detail)) ? DRIVE_EXIT.HITL_PARKED : 1;
  }
  const note = result.code === 0 ? "" : ` (pass exit ${result.code})`;
  return await pushedHeadOutcome(pr, head, receipt, note);
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
  const earlier = await standDownsAt(pr, head);
  if (earlier === null) return 1;
  if (earlier + 1 >= STAND_DOWN_LIMIT)
    return await stopWithDiagnosis(
      pr,
      head,
      `The diagnosing pass stood down ${earlier + 1} times on this head without diagnosing it.`,
    );
  const recorded = await recordSkipped(pr, head, STOOD_DOWN, earlier + 1);
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
    const recorded = await recordSkipped(
      pr,
      head,
      `the pull request moved to ${current.value.head}`,
    );
    return recorded ? "continue" : 1;
  }
  return await stopWithDiagnosis(
    pr,
    head,
    current.ok
      ? "The diagnosing pass reported a changed head, but the forge still reports the failing head."
      : `The diagnosing pass reported a changed head that could not be verified: ${redactReportText(current.failure.reason)}`,
  );
}

/** What the forge says of the pass's reported push. */
function pushedOutcomeText(
  current: Awaited<ReturnType<typeof readPrSnapshot>>,
  pushedHead: string,
  verified: boolean,
): string {
  if (!current.ok)
    return `The pushed head could not be verified: ${current.failure.reason}`;
  return verified
    ? `The pull request moved to ${pushedHead}.`
    : `The pull request is at ${current.value.head}, but the pass reported a push to ${pushedHead}.`;
}

/** Record the accepted diagnosis beside what the forge says of its push. */
async function pushedHeadOutcome(
  pr: string,
  head: string,
  receipt: Extract<Receipt, { text: string }>,
  passNote = "",
): Promise<number | "continue"> {
  const { pushedHead, parked } = receipt;
  const diagnosis = `${receipt.text}${passNote}`;
  const exit = parked ? DRIVE_EXIT.HITL_PARKED : CI_REPAIR_SPENT_EXIT;
  if (pushedHead === undefined || pushedHead === head) {
    const recorded = await reportOutcome(
      pr,
      head,
      `${diagnosis} The pass reported no replacement head pushed.`,
    );
    return recorded ? exit : 1;
  }
  const current = await readPrSnapshot(pr, null);
  const verified = current.ok && current.value.head === pushedHead;
  const outcome = pushedOutcomeText(current, pushedHead, verified);
  const recorded = await reportOutcome(
    pr,
    head,
    `${diagnosis} ${redactReportText(outcome)}`,
  );
  if (current.ok && current.value.state !== "OPEN") return 5;
  if (!recorded) return 1;
  return verified ? "continue" : exit;
}
