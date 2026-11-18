/**
 * The closing reports the wrapper (`run.ts`) records itself, and the report
 * it prints as a run's last lines.
 *
 * - **A drive's**, by its driver (`by: driver`). The wrapper starts
 *   `drive.ts` with `JIG_DRIVER_REPORT` naming `drive-report.json` in the
 *   run's own state directory (`runs/<record>/`, under the dispatcher's
 *   state root, readable only by its owner); once the drive ended, it reads
 *   the report the driver wrote there for this record
 *   (`shared/driver-report.ts`), checks it again, records it under the
 *   record and removes the file. A drive that ended without writing one
 *   leaves no report (`by: none`).
 * - **A pass that could not start** (`by: wrapper`): a follow-up, pickup or
 *   steward pass the wrapper classifies as unstarted (`session-startup.ts`),
 *   with cause `usage-limit` for a vendor usage notice and `startup`
 *   otherwise, unless the pass recorded a report of its own.
 *
 * Whatever report the record keeps once the run ended, the wrapper prints
 * as its last lines, so a person watching the run reads it there too.
 */
import { rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLOSING_REPORT_SCHEMA,
  type ClosingReport,
} from "../../shared/closing-report.ts";
import { readDriverReport } from "../../shared/driver-report.ts";
import { errnoCode, swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import {
  type KeptReport,
  readKeptReport,
  recordReport,
} from "./closing-report-store.ts";
import { isDrive, type LaunchAction } from "./launches.ts";
import { startupNext } from "./session-startup.ts";
import { stateDb } from "./state.ts";

/** The file the wrapper names for a drive's closing report: in the run's own state directory. */
export function driverReportFile(id: string, root = stateRoot()): string {
  return join(root, "runs", id, "drive-report.json");
}

/**
 * Remove the report file, and the run's directory when nothing else is in
 * it; the line to print when the file itself could not be removed.
 */
function removeReportFile(path: string): string | null {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    return `the driver's report file could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    rmdirSync(dirname(path));
  } catch (error) {
    const code = errnoCode(error);
    if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "EEXIST")
      return `the run's directory could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/**
 * Record the closing report the driver of record `id` wrote, by the driver;
 * the line to print when it could not be taken, `null` when it was recorded
 * or the driver wrote none.
 */
function takeDriverReport(id: string, root = stateRoot()): string[] {
  const path = driverReportFile(id, root);
  const read = readDriverReport(path, id);
  if (!read.ok)
    return withRemoval(path, [
      `the driver's closing report was not recorded: ${read.failure.reason}`,
    ]);
  if (read.value === null) return [];
  const recorded = recordReport(id, read.value, "driver", root);
  return withRemoval(
    path,
    recorded
      ? []
      : [
          `the driver's closing report was not recorded: ${id} is not a launch record`,
        ],
  );
}

/** `lines`, and the line saying the report file could not be removed, once it is removed. */
function withRemoval(path: string, lines: string[]): string[] {
  const removal = removeReportFile(path);
  return removal === null ? lines : [...lines, removal];
}

/** The report the wrapper records for a pass that could not start. */
function startupReport(
  action: LaunchAction,
  startup: "quota" | "unstarted",
): ClosingReport {
  return {
    schema: CLOSING_REPORT_SCHEMA,
    concluded:
      startup === "quota"
        ? "The pass could not start: its account met a usage limit, and the account is walled."
        : "The pass could not start: it exited at once, without a result or a transcript, and its account backs off.",
    suggested_next: startupNext(action, startup),
    cause: startup === "quota" ? "usage-limit" : "startup",
  };
}

/** A kept report as the lines the wrapper prints. */
function reportLines(kept: KeptReport): string[] {
  const { report } = kept;
  const next = report.suggested_next;
  return [
    `jig dispatch run: closing report (by ${kept.by}):`,
    `  concluded: ${report.concluded}`,
    ...(report.question === undefined
      ? []
      : [`  question: ${report.question}`]),
    `  next (${next.owner === "person" ? `person, ${next.act ?? "Do"}` : next.owner}): ${next.step}`,
    ...(report.cause === undefined ? [] : [`  cause: ${report.cause}`]),
  ];
}

/** The report record `id` keeps; `null` when it keeps none. */
function keptReport(id: string, root = stateRoot()): KeptReport | null {
  const row = stateDb(root)
    .query("SELECT report FROM launches WHERE id = ?")
    .get(id) as { report: string | null } | null;
  return readKeptReport(row?.report);
}

/**
 * Record what the wrapper itself records for record `id` as its run ended,
 * before its exit: a drive's report by its driver, or the report of a pass
 * that could not start (`startup`) when the pass recorded none. Returns the
 * lines to print for what could not be recorded; a failure never costs the
 * exit.
 */
function recordRunReport(
  id: string,
  action: LaunchAction,
  startup: "quota" | "unstarted" | undefined,
  root = stateRoot(),
): string[] {
  try {
    if (isDrive({ action })) return takeDriverReport(id, root);
    if (startup !== undefined && keptReport(id, root) === null)
      recordReport(id, startupReport(action, startup), "wrapper", root);
    return [];
  } catch (error) {
    return [
      `the run's closing report was not recorded: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/** `recordRunReport`, each line it returns printed on the wrapper's error output. */
export function recordAndSay(
  id: string,
  action: LaunchAction,
  startup: "quota" | "unstarted" | undefined,
): void {
  for (const line of recordRunReport(id, action, startup))
    console.error(`jig dispatch run: ${line}`);
}

/** Print the report record `id` keeps as the run's last lines; nothing when it keeps none. */
export function printKeptReport(id: string): void {
  for (const line of keptReportLines(id)) console.error(line);
}

/** The lines to print for the report record `id` keeps, as the run's last lines; none when it keeps none. */
function keptReportLines(id: string, root = stateRoot()): string[] {
  try {
    const kept = keptReport(id, root);
    return kept === null ? [] : reportLines(kept);
  } catch (error) {
    swallow(error, "the run's closing report could not be read to print");
    return [];
  }
}
