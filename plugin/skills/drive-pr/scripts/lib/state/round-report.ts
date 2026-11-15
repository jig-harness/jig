/**
 * A drive pass's round report: what its round concluded, the same fields as
 * a closing report (`closing-report/v1`, `shared/closing-report.ts`), kept in
 * the drive's state directory as `drive-pr-<PR>.round-report.json`, and
 * never in the handoff narrative, whose last lines the drive ledger posts on
 * the pull request. Each pass ends its round by writing one
 * (`round-report.ts`), stamped with the launch it runs under (`JIG_LAUNCH`)
 * and its round (`DRIVE_PR_ROUND`), both of which the driver hands it; the
 * pass's report replaces the one before it.
 *
 * When `drive.ts` stops, its closing report reads the last round report of
 * its own launch (`driver/closing-report.ts`): a report stamped with another
 * launch, or with a round other than the last one this driver ran a pass
 * for, is never read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ClosingReport,
  closingReportOf,
} from "../../../../../shared/closing-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { atomicWrite } from "./fsutil.ts";

export const ROUND_REPORT_SCHEMA = "drive-round-report/v1";

/** A round report as the state directory keeps it. */
export interface RoundReport {
  schema: typeof ROUND_REPORT_SCHEMA;
  pr: number;
  /** The launch the pass ran under: a dispatcher's launch record, or the driver's own name. */
  launch: string;
  round: number;
  /** When it was written. */
  at: string;
  report: ClosingReport;
}

/** Where a pull request's round report is kept. */
export function roundReportFile(stateDir: string, pr: string): string {
  return join(stateDir, `drive-pr-${pr}.round-report.json`);
}

/** Keep `rr` as its pull request's round report, replacing the one before it. */
export function writeRoundReport(stateDir: string, rr: RoundReport): void {
  atomicWrite(
    roundReportFile(stateDir, String(rr.pr)),
    `${JSON.stringify(rr)}\n`,
  );
}

/** Whether a kept value reads as a round report; its report is checked again by the caller. */
function isRoundReport(value: unknown): value is RoundReport {
  return (
    isRecord(value) &&
    value.schema === ROUND_REPORT_SCHEMA &&
    typeof value.pr === "number" &&
    typeof value.launch === "string" &&
    typeof value.round === "number" &&
    typeof value.at === "string" &&
    isRecord(value.report)
  );
}

/**
 * The report of pull request `pr`'s round report, when it is stamped with
 * `launch` and `round` and still passes the check; `null` otherwise, and
 * when there is none or it does not read.
 */
export function readRoundReport(
  stateDir: string,
  pr: string,
  launch: string,
  round: number,
): ClosingReport | null {
  const file = roundReportFile(stateDir, pr);
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    swallow(error, "the round report does not read");
    return null;
  }
  if (
    !isRoundReport(value) ||
    String(value.pr) !== pr ||
    value.launch !== launch ||
    value.round !== round
  )
    return null;
  const checked = closingReportOf(JSON.stringify(value.report));
  if (checked.ok) return checked.value;
  swallow(checked.failure, "the round report does not pass the check");
  return null;
}
