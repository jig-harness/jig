/**
 * Where a run's closing report (`shared/closing-report.ts`) is kept. The
 * launch record keeps it whole beside the result, in the `report` column,
 * with who wrote it and when, so the tick and the steward read it while the
 * record lives; each later report that passes the check replaces it, and
 * none touches the result. The outcome log's `ended` row for the record
 * carries its `concluded`, `question`, `suggested_next`, `cause` and who
 * wrote it (`by`), and, with a question, its framed `decision`, so the log
 * keeps a run's conclusion after the record expires; `cause` and `by` are
 * columns too (`report_by`), which the dashboard filters on. A run that
 * ended without a report has `by: none`. A report recorded after the row
 * was written refreshes the row's fields in the same transaction.
 */
import { isMapping } from "../../shared/config-layers.ts";
import {
  type ClosingReport,
  isClosingReport,
  REPORT_WRITERS,
  type ReportCause,
  type ReportWriter,
  type SuggestedNext,
} from "../../shared/closing-report.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import { inTransaction, stateDb } from "./state.ts";

/** A report as the launch record keeps it. */
export interface KeptReport {
  report: ClosingReport;
  by: ReportWriter;
  /** When it was recorded. */
  at: string;
}

/** What an `ended` row carries of its record's report. */
export interface ReportFields {
  /** Who wrote the report; `none` when the run left none. Absent on rows written before reports were kept. */
  by?: ReportWriter;
  concluded?: string;
  question?: string;
  /** With `question`, the decision the report framed for it. */
  decision?: ParkedDecision;
  suggested_next?: SuggestedNext;
  cause?: ReportCause;
}

/** The fields of `ReportFields`, which a refreshed row replaces. */
const FIELDS = [
  "by",
  "concluded",
  "question",
  "decision",
  "suggested_next",
  "cause",
] as const;

/** A kept report as a reader takes it; `null` for none, or one that does not read. */
export function readKeptReport(
  json: string | null | undefined,
): KeptReport | null {
  if (json == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    swallow(err, "a closing report kept with a launch record does not read");
    return null;
  }
  return isMapping(value) &&
    isClosingReport(value.report) &&
    (REPORT_WRITERS as readonly unknown[]).includes(value.by) &&
    typeof value.at === "string"
    ? { report: value.report, by: value.by as ReportWriter, at: value.at }
    : null;
}

/** An `ended` row's report fields: the report's own, or `by: none` without one. */
export function reportFields(
  kept: KeptReport | null | undefined,
): ReportFields {
  if (kept == null) return { by: "none" };
  const { report } = kept;
  return {
    by: kept.by,
    concluded: report.concluded,
    ...(report.question === undefined ? {} : { question: report.question }),
    ...(report.question === undefined || report.decision === undefined
      ? {}
      : { decision: report.decision }),
    suggested_next: report.suggested_next,
    ...(report.cause === undefined ? {} : { cause: report.cause }),
  };
}

/**
 * Keep `report` on record `id`, replacing any earlier report, and refresh
 * the record's `ended` row when it is already written; false when there is
 * no such record. The result is never read or written.
 */
export function recordReport(
  id: string,
  report: ClosingReport,
  by: ReportWriter,
  root = stateRoot(),
  at = new Date().toISOString(),
): boolean {
  const db = stateDb(root);
  const kept: KeptReport = { report, by, at };
  return inTransaction(db, () => {
    const done = db
      .query("UPDATE launches SET report = ? WHERE id = ?")
      .run(JSON.stringify(kept), id);
    if (done.changes !== 1) return false;
    refreshEnded(db, id, kept);
    return true;
  });
}

/** Record `id`'s ended row as the log keeps it, to be rewritten; `null` before it is written. */
export function storedEndedRow(
  db: ReturnType<typeof stateDb>,
  id: string,
): Record<string, unknown> | null {
  const stored = db
    .query("SELECT row FROM log WHERE key = ?")
    .get(`ended ${id}`) as { row: string } | null;
  const row: unknown = stored === null ? null : JSON.parse(stored.row);
  return isMapping(row) && row.kind === "ended" ? row : null;
}

/** An ended row already written takes the report's fields, and is exported again. */
function refreshEnded(
  db: ReturnType<typeof stateDb>,
  id: string,
  kept: KeptReport,
): void {
  const row = storedEndedRow(db, id);
  if (row === null) return;
  for (const field of FIELDS) delete row[field];
  const fields = reportFields(kept);
  Object.assign(row, fields);
  db.query(
    "UPDATE log SET seq = (SELECT MAX(seq) + 1 FROM log), cause = ?, report_by = ?, row = ? WHERE key = ?",
  ).run(
    fields.cause ?? null,
    fields.by ?? null,
    JSON.stringify(row),
    `ended ${id}`,
  );
}
