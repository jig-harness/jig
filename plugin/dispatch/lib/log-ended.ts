/**
 * The tick's part of the outcome log (`log.ts`) for launch records: each
 * record that ended gets its ended row once. The record's end (`endedAt`,
 * the time the row carries) and the row are written in one transaction,
 * so either both are in the database or neither is: a record with its end
 * written has its row, and one without is ended and logged by the next
 * tick that reads it. The result, the handoff and the closing report are
 * read under the same write transaction so a session reporting during a
 * tick is not lost.
 *
 * A run that left no closing report is settled first, as its wrapper
 * settles it at its exit (`end-report.ts`), for a run whose wrapper died or
 * did not: the report its wrapper would record, else the copy of its
 * transcript. A run that still has no report carries the copy's path on its
 * row (`transcript`), which the dashboard shows.
 *
 * A run whose wrapper died, ending without recording an exit, also left
 * what the wrapper would have closed: once its row is written, a tick that
 * may act (`endRun` given, under `--apply`) asks the session runtime to end
 * it, once, as the record's row is written once. On Orca that closes the
 * run's recorded tab by the idle checks; what stays is `jig gc`'s.
 */
import { Defect } from "../../shared/errors.ts";
import { readNext } from "./next-owner.ts";
import { readKeptReport } from "./closing-report-store.ts";
import { type SeenEnd, settleUnreported } from "./end-report.ts";
import { readTranscriptCopy } from "./transcript-copy.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { failureText } from "./text.ts";
import {
  asResult,
  isDrive,
  type ReadRecord,
  targetOf,
  writeRecord,
} from "./launches.ts";
import { endedRow, endTime, hasEnded, insertRow } from "./log.ts";
import { waitsOf } from "./pickup-refusal.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { EndedRun, RuntimeReceipt } from "./runtime/port.ts";
import type { DrivenPr, EndRunOutcome } from "./types.ts";

export interface EndContext {
  /** Every launch record this tick read, for the takeovers that replaced one. */
  all: ReadRecord[];
  /** The repository's driven pull requests as this tick read them; `null` when the forge was not read. */
  drives: DrivenPr[] | null;
  /** Whether a pull request merged (true) or closed (false); `null` when that cannot be read. */
  merged: (pr: number) => Promise<boolean | null>;
  nowIso: string;
  root?: string;
  /** A target's title and link as this tick's reads gave them; absent where the repository was not read. */
  about?: (target: string) => { title: string | null; url: string | null };
  /** The session runtime's `endRun`, for a run whose wrapper died; absent on a tick that may not act. */
  endRun?: (run: EndedRun) => Promise<RuntimeReceipt>;
}

/** What logging the ended records did: the rows that could not be written, and what `endRun` did. */
export interface Logged {
  failed: string[];
  ended: EndRunOutcome[];
}

/** Ask the runtime to end what a run whose wrapper died left; a failure is its outcome, never the row's. */
async function endDied(
  record: ReadRecord["record"],
  endRun: NonNullable<EndContext["endRun"]>,
): Promise<EndRunOutcome> {
  const about = { record: record.id, target: targetOf(record) };
  try {
    const receipt = await endRun({
      id: record.id,
      workspace: record.workspace,
    });
    return {
      ...about,
      outcome: receipt.ok ? "ended" : "left",
      detail: receipt.detail,
    };
  } catch (error) {
    return { ...about, outcome: "left", detail: failureText(error) };
  }
}

/** A drive's ledger round at its end: the ledger this tick read, else the last round a sample recorded. */
function endRound(r: ReadRecord, drives: DrivenPr[] | null): number | null {
  const round = drives?.find((d) => d.number === r.record.pr)?.evidence.round;
  if (typeof round === "number") return round;
  return r.record.samples?.at(-1)?.round ?? null;
}

/** What the tick reads of a run's end from its record, as its wrapper saw it; `null` for a run whose wrapper died. */
function seenOf(r: ReadRecord): SeenEnd | null {
  if (r.state.kind !== "ended") return null;
  const { exit } = r.state;
  return {
    code: exit.code,
    signal: exit.signal,
    ...(exit.startup === undefined ? {} : { startup: exit.startup }),
    ...(exit.context === undefined ? {} : { output: exit.context }),
  };
}

/** The path of a run's transcript copy, for its row, while it holds no report. */
function transcriptField(
  id: string,
  reported: boolean,
  root: string | undefined,
): { transcript?: string } {
  const path = reported ? null : readTranscriptCopy(id, root)?.transcript;
  return typeof path === "string" ? { transcript: path } : {};
}

/** Recover a report or transcript for a run its wrapper did not settle. */
function settleEnded(r: ReadRecord, root?: string): void {
  if ((r.report ?? null) !== null) return;
  const session =
    r.state.kind === "ended" ? (r.state.exit.session ?? null) : null;
  settleUnreported(r.record, seenOf(r), r.record.sessionId ?? session, root);
}

/** Write the ended row of each record in `records` that ended and has none yet, and end what a died run left; returns what failed and what was ended. */
export async function logEnded(
  records: ReadRecord[],
  ctx: EndContext,
): Promise<Logged> {
  const failed: string[] = [];
  const ended: EndRunOutcome[] = [];
  for (const r of records) {
    const { record } = r;
    if (!hasEnded(r) || record.endedAt !== undefined) continue;
    try {
      const exit = r.state.kind === "ended" ? r.state.exit.code : null;
      const merged =
        isDrive(record) && exit === DRIVE_EXIT.PR_NOT_OPEN && record.pr !== null
          ? await ctx.merged(record.pr)
          : null;
      const takenOver = ctx.all.some((x) => x.record.replaces === record.id);
      const endedAt = endTime(r, ctx.nowIso);
      settleEnded(r, ctx.root);
      const db = stateDb(ctx.root);
      inTransaction(db, () => {
        const current = db
          .query(
            "SELECT result, result_next, result_until, result_wait, report FROM launches WHERE id = ?",
          )
          .get(record.id) as {
          result: string | null;
          result_next: string | null;
          result_until: string | null;
          result_wait: string | null;
          report: string | null;
        } | null;
        if (current === null)
          throw new Defect("the launch record disappeared before logging");
        const fresh = {
          ...r,
          result: asResult(current.result, current.result_until),
          ...waitsOf(current),
          next: readNext(current.result_next),
          report: readKeptReport(current.report),
        };
        const row = {
          ...endedRow(
            fresh,
            endedAt,
            { takenOver, merged },
            isDrive(record) ? endRound(r, ctx.drives) : null,
            ctx.about?.(targetOf(record)),
          ),
          ...transcriptField(record.id, fresh.report !== null, ctx.root),
        };
        writeRecord({ ...record, endedAt }, ctx.root);
        insertRow(db, row);
      });
      record.endedAt = endedAt;
    } catch (error) {
      failed.push(
        `the outcome row of launch record ${record.id} could not be written: ${failureText(error)}`,
      );
      continue;
    }
    if (r.state.kind === "died" && ctx.endRun !== undefined)
      ended.push(await endDied(record, ctx.endRun));
  }
  return { failed, ended };
}
