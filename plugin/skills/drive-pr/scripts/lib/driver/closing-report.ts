/**
 * The closing report `drive.ts` writes when it stops (`closing-report/v1`,
 * `by: driver`; design/dispatched-sessions.md § The closing report). Most of
 * a drive's stops are decided by the driver after a pass has ended, so no
 * pass knows it is the last: each pass writes a round report instead
 * (`state/round-report.ts`), and the driver composes the run's report from
 * its own stop and the last of those.
 *
 * - `cause` and `suggested_next` are the terminal-state registry's `report`
 *   for the exit (`status/terminal-states.ts`); an exit the registry does
 *   not name has cause `unknown` and asks a person to investigate. A stall
 *   whose passes all ended `finish-round.ts` on the same state takes its
 *   cause from that state (`state/round-finish.ts`).
 * - `concluded` is the stop's own text (`stop-text.ts`) followed by the
 *   `concluded` of the last round report of this launch, the stop's text
 *   first and the round's cut to the room left in the 600 characters; the
 *   stop's text alone is cut to the limit when it exceeds it, so the field
 *   always passes the check. Both parts are redacted before they are
 *   measured.
 * - A pass failure (`INDETERMINATE`) whose usage-limit scan was cut short
 *   before it found a wall (`driverRuntime.quotaScanTruncated`) says so in
 *   `concluded`, with cause `unknown` and a next step that looks for the
 *   notice first: a wall the scan did not reach is not a tool failure.
 * - `question` and `decision` come from the drive's own state, never from a
 *   round report: at a park (`HITL_PARKED`), the question and framed
 *   decision (`parked-decision/v1`) of the first parked item, the one the
 *   stop prints, whose text names how many more wait; a stop that parks
 *   nothing writes neither.
 *
 * A round report stamped with another launch, with a round other than
 * the last one this driver started a pass for, or written before that pass
 * started, is never read. The report is
 * written only when the dispatcher's wrapper named a file for it
 * (`shared/driver-report.ts`); a drive armed any other way writes none.
 */
import {
  type ClosingReport,
  type ReportCause,
  CLOSING_REPORT_SCHEMA,
  CONCLUDED_MAX,
  closingReportOf,
  redactReportText,
} from "../../../../../shared/closing-report.ts";
import type { ParkedDecision } from "../../../../../shared/decisions/park.ts";
import {
  driverReportPath,
  writeDriverReport,
} from "../../../../../shared/driver-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { launchOf } from "../../../../../shared/launched-session.ts";
import type { ParkedItem } from "../state/park-frame.ts";
import { readRoundReport } from "../state/round-report.ts";
import type { DriveState } from "../state/schema.ts";
import { probeFailure } from "../status/probe-stop.ts";
import { driveExitReport } from "../status/terminal-states.ts";
import { readDriveState } from "./rearm.ts";
import { driverRuntime } from "./runtime.ts";
import { finishCause } from "../state/round-finish.ts";
import {
  exitOf,
  leadPark,
  oneLine,
  type StallFinish,
  stopText,
} from "./stop-text.ts";

/** What marks a text cut short. */
const ELLIPSIS = "…";
/** What joins the stop's text and the last round's conclusion. */
const ROUND_JOIN = " Last round: ";
/** The longest question a report holds (`shared/closing-report.ts`). */
const QUESTION_MAX = 1000;

function chars(text: string): number {
  return [...text].length;
}

/** `text` cut to at most `max` characters, the cut marked with an ellipsis. */
export function cutTo(text: string, max: number): string {
  if (chars(text) <= max) return text;
  if (max <= 0) return "";
  return `${[...text].slice(0, max - 1).join("")}${ELLIPSIS}`;
}

/**
 * The report's `concluded`: the stop's text, then the last round's
 * conclusion cut to the room left; the stop's text cut to the limit when it
 * alone exceeds it. Never longer than the check allows.
 */
export function composeConcluded(stop: string, round: string | null): string {
  const head = cutTo(stop, CONCLUDED_MAX);
  if (round === null || round.trim() === "") return head;
  const room = CONCLUDED_MAX - chars(head) - chars(ROUND_JOIN);
  if (room < 2) return head;
  return `${head}${ROUND_JOIN}${cutTo(oneLine(round), room)}`;
}

/** A parked item's reason as one question, when it is not one already. */
function asQuestion(item: ParkedItem): string {
  const reason = oneLine(redactReportText(item.reason));
  if (reason.endsWith("?") && chars(reason) <= QUESTION_MAX) return reason;
  const body = `What is the decision on ${item.kind} ${item.key}: ${reason.replace(/[\s.!?:;,]+$/, "")}`;
  return `${cutTo(body, QUESTION_MAX - 1)}?`;
}

/** The question and framed decision of the parked item a park's stop prints. */
export function parkAsk(
  code: number,
  state: DriveState | null,
): { question: string; decision?: ParkedDecision } | null {
  if (code !== exitOf("HITL_PARKED")) return null;
  const first = leadPark(state);
  if (first === undefined) return null;
  const decision = first.decision;
  return decision === undefined
    ? { question: asQuestion(first) }
    : { question: decision.call.question, decision };
}

/** The report checked as `jig dispatch report` checks one, or `null` when the check refuses it. */
function checked(report: ClosingReport): ClosingReport | null {
  const done = closingReportOf(JSON.stringify(report));
  return done.ok ? done.value : null;
}

/**
 * The driver's closing report for pull request `pr`'s stop with exit
 * `code`, from the drive's state (`null` when it could not be read) and the
 * last round report of this launch (`null` when there is none). It always
 * passes the check: a framed decision the check refuses leaves the question
 * alone, and a question it refuses leaves the stop's own fields.
 */
export function composeDriverReport(input: {
  pr: string;
  code: number;
  state: DriveState | null;
  round: ClosingReport | null;
  stall?: StallFinish | null;
}): ClosingReport {
  const { pr, code, state, round } = input;
  const stall = code === exitOf("STALLED") ? (input.stall ?? null) : null;
  const named = driveExitReport(code);
  const probe = driverRuntime.stopProbe;
  const failure = probe?.code === code ? probeFailure(probe) : null;
  const unscanned = failure === null ? unscannedWall(code) : null;
  const stop = redactReportText(
    `${stopText(pr, code, state, stall)}${unscanned === null ? "" : unscanned.note}`,
  );
  const cause =
    failure !== null
      ? "environment"
      : named === null || unscanned !== null
        ? "unknown"
        : stall !== null
          ? finishCause(stall.state)
          : named.report.cause;
  const concluded = composeConcluded(
    stop,
    round === null ? null : redactReportText(round.concluded),
  );
  const base = baseDriverReport(pr, concluded, named, cause);
  if (unscanned !== null) base.suggested_next = unscanned.next;
  const ask = parkAsk(code, state);
  return checkedDriverReport(base, ask, state, stop);
}

/**
 * What a pass failure adds when its usage-limit scan was cut short
 * (`driverRuntime.quotaScanTruncated`): a note for the stop's line and a next
 * step that looks for the notice first. `null` for any other stop.
 */
function unscannedWall(
  code: number,
): { note: string; next: ClosingReport["suggested_next"] } | null {
  const vendors = driverRuntime.quotaScanTruncated;
  if (code !== exitOf("INDETERMINATE") || vendors.length === 0) return null;
  return {
    note: `; the usage-limit scan of the pass's ${[...new Set(vendors)].join(" and ")} transcripts was cut short before it found a wall, so a usage limit may have stopped the pass`,
    next: {
      step: "Look for a usage-limit notice in the failed pass's transcript before re-arming: if there is one, re-arm after its reset or on another account.",
      owner: "person",
      act: "Investigate",
    },
  };
}

function baseDriverReport(
  pr: string,
  concluded: string,
  named: ReturnType<typeof driveExitReport>,
  cause: ReportCause | undefined,
): ClosingReport {
  return {
    schema: CLOSING_REPORT_SCHEMA,
    concluded,
    suggested_next:
      named === null
        ? {
            step: "Read the drive's log for how it ended, then re-arm the drive.",
            owner: "person",
            act: "Investigate",
          }
        : { ...named.report.next },
    ...(cause === undefined ? {} : { cause }),
    evidence: [`pr:#${pr}`],
  };
}

function checkedDriverReport(
  base: ClosingReport,
  ask: ReturnType<typeof parkAsk>,
  state: DriveState | null,
  stop: string,
): ClosingReport {
  const tries: ClosingReport[] =
    ask === null
      ? [base]
      : [
          { ...base, ...ask },
          { ...base, question: asQuestion(leadPark(state) as ParkedItem) },
          base,
        ];
  for (const report of tries) {
    const kept = checked(report);
    if (kept !== null) return kept;
  }
  return {
    schema: CLOSING_REPORT_SCHEMA,
    concluded: cutTo(stop, CONCLUDED_MAX),
    suggested_next: base.suggested_next,
    ...(base.cause === undefined ? {} : { cause: base.cause }),
  };
}

/**
 * Write the driver's closing report for pull request `pr`'s stop with exit
 * `code` to the file the dispatcher's wrapper named, best effort: nothing
 * when no wrapper named one, and a report that cannot be written is one line
 * on the driver's output, never a change to its exit. `stateDir` is the
 * drive's state directory, where the round report is kept; empty when the
 * drive stopped before it was resolved. `stopped` is the state read at the
 * stop while the driver held its locks; without it the state is read now.
 */
export async function writeClosingReport(
  pr: string,
  code: number,
  stateDir: string,
  env: Record<string, string | undefined> = process.env,
  stopped?: { state: DriveState | null },
): Promise<void> {
  const path = driverReportPath(env);
  const launch = launchOf(env);
  if (path === null || launch === null) return;
  try {
    const state =
      stopped !== undefined
        ? stopped.state
        : await readDriveState(pr).catch((error: unknown) => {
            swallow(error, "the drive state could not be read for its report");
            return null;
          });
    const roundNumber = driverRuntime.passRound;
    const round =
      stateDir === "" || roundNumber === null
        ? null
        : readRoundReport(
            stateDir,
            pr,
            launch,
            roundNumber,
            driverRuntime.passStartedAt,
          );
    writeDriverReport(
      path,
      launch,
      composeDriverReport({
        pr,
        code,
        state,
        round,
        stall: driverRuntime.stallFinish,
      }),
    );
  } catch (error) {
    console.error(
      `drive.ts: the closing report was not written (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
