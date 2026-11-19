/**
 * What a pass's end leaves when the pass recorded no closing report. The
 * wrapper records what it observed, `by: wrapper`: a pass that could not
 * start (`startup`, or `usage-limit` on the vendor's notice, as
 * `session-startup.ts` classifies it), a pass it stopped at its deadline
 * (`deadline`), and any steward pass, with the cause it saw, else
 * `unknown`, since the steward is never asked about its own runs. A
 * pickup's or a follow-up's pass that it cannot explain stays `by: none`,
 * and its transcript is copied (`transcript-copy.ts`) for the steward to
 * record its cause from. For a drive, a recorded probe stop can explain an
 * end when the driver left no report.
 *
 * The wrapper settles this before it records the exit, so the tick that
 * writes the run's outcome row reads it; the tick settles it for a run
 * whose wrapper died, or an earlier release's wrapper that did not.
 * Neither replaces a report the run's own writer recorded.
 */
import {
  CLOSING_REPORT_SCHEMA,
  type ClosingReport,
  type ReportCause,
  type SuggestedNext,
} from "../../shared/closing-report.ts";
import {
  probeFailure,
  readProbeStop,
} from "../../skills/drive-pr/scripts/lib/status/probe-stop.ts";
import { driveExitReport } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import { recordReportIfNone } from "./closing-report-store.ts";
import { isDrive, type LaunchRecord } from "./launches.ts";
import { reportsUsageLimit } from "./pass-output.ts";
import { startupNext } from "./session-startup.ts";
import { stateDb } from "./state.ts";
import { keepTranscriptCopy } from "./transcript-copy.ts";

/** What the wrapper saw of a pass's end; `null` for a run whose wrapper died without recording one. */
export interface SeenEnd {
  code: number | null;
  signal: string | null;
  startup?: "quota" | "unstarted";
  /** The wrapper stopped the pass at its deadline. */
  timedOut?: boolean;
  /** The end of the pass's output the wrapper kept, to recognise a vendor notice. */
  output?: string;
}

/** Whether a run of this record's stage is put to the steward when it leaves no report: a pickup's or a follow-up's. */
export function causeAsked(record: Pick<LaunchRecord, "action">): boolean {
  return record.action === "pickup" || record.action === "followup";
}

function report(
  concluded: string,
  next: SuggestedNext,
  cause: ReportCause,
): ClosingReport {
  return {
    schema: CLOSING_REPORT_SCHEMA,
    concluded,
    suggested_next: next,
    cause,
  };
}

/** The next step after a steward pass: the records it submitted applied, or the pass started again. */
function stewardNext(submitted: boolean): SuggestedNext {
  return {
    step: submitted
      ? "The next tick applies the records the pass submitted."
      : "The tick starts the steward again while its judgment backlog holds a member no pass judged.",
    owner: "line",
  };
}

/** How the pass ended, in words. */
function howEnded(seen: SeenEnd | null): string {
  if (seen === null) return "ended without its wrapper recording an exit";
  return seen.code !== null
    ? `exited with code ${seen.code}`
    : `ended on ${seen.signal ?? "a signal"}`;
}

/**
 * The report the wrapper records for a pass that left none, from what it
 * saw; `null` when the available evidence does not explain the end.
 */
export function wrapperReport(
  record: Pick<LaunchRecord, "action" | "passTimeoutSec">,
  seen: SeenEnd | null,
  submitted = false,
): ClosingReport | null {
  if (isDrive(record)) {
    const probe = readProbeStop(seen?.output ?? "");
    if (probe === null || probe.code !== seen?.code) return null;
    const named = driveExitReport(probe.code);
    if (named === null) return null;
    return report(
      `Status probe stopped the drive at exit ${probe.code} (${probe.state}): ${probe.reason}`,
      named.report.next,
      probeFailure(probe) === null
        ? (named.report.cause ?? "unknown")
        : "environment",
    );
  }
  const steward = record.action === "steward";
  if (seen?.startup === "quota")
    return report(
      "The pass could not start: its account was at its usage limit.",
      startupNext(record.action, "quota"),
      "usage-limit",
    );
  if (seen?.startup === "unstarted")
    return report(
      "The pass could not start: it exited unsuccessfully within its first minute and left no transcript.",
      startupNext(record.action, "unstarted"),
      "startup",
    );
  if (seen?.timedOut === true)
    return report(
      `The wrapper stopped the pass at its ${typeof record.passTimeoutSec === "number" ? `${record.passTimeoutSec}-second ` : ""}deadline; the pass left no closing report.`,
      steward
        ? stewardNext(submitted)
        : {
            step: "Nothing further from the wrapper: the outcome row's next owner says who takes the work.",
            owner: "none",
          },
      "deadline",
    );
  if (!steward) return null;
  return report(
    `The steward pass ${howEnded(seen)} and left no closing report; it ${submitted ? "submitted its records" : "submitted no records"}.`,
    stewardNext(submitted),
    reportsUsageLimit(seen?.output ?? "") ? "usage-limit" : "unknown",
  );
}

/** Whether the steward run of record `id` submitted its records. */
function submittedRun(root: string, id: string): boolean {
  const row = stateDb(root)
    .query("SELECT submitted FROM steward_runs WHERE id = ?")
    .get(id) as { submitted: number } | null;
  return row?.submitted === 1;
}

/**
 * Settle the end of a pass that recorded no report: the wrapper's report
 * where it explains the end, else, for a pickup or a follow-up, the copy of
 * its transcript under `session`. Best effort: a failure leaves the run
 * `by: none`, and the exit is still recorded.
 */
export function settleUnreported(
  record: Pick<
    LaunchRecord,
    | "id"
    | "token"
    | "action"
    | "vendor"
    | "configDir"
    | "createdAt"
    | "passTimeoutSec"
  >,
  seen: SeenEnd | null,
  session: string | null,
  root = stateRoot(),
): void {
  try {
    const row = stateDb(root)
      .query("SELECT report IS NOT NULL AS reported FROM launches WHERE id = ?")
      .get(record.id) as { reported: number } | null;
    if (row === null || row.reported === 1) return;
    const explained = wrapperReport(
      record,
      seen,
      record.action === "steward" && submittedRun(root, record.id),
    );
    if (explained !== null) {
      recordReportIfNone(record.id, explained, "wrapper", root);
      return;
    }
    if (causeAsked(record)) keepTranscriptCopy(record, session, root);
  } catch (error) {
    swallow(error, "the end of a pass that left no report was not settled");
  }
}
