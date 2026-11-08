/**
 * The tick's part of the outcome log (`log.ts`) for launch records: each
 * record that ended gets its ended row once. The record's end (`endedAt`,
 * the time the row carries) and the row are written in one transaction,
 * so either both are in the database or neither is: a record with its end
 * written has its row, and one without is ended and logged by the next
 * tick that reads it. The result and handoff are read under the same write
 * transaction so a session reporting during a tick is not lost.
 */
import { Defect } from "../../shared/errors.ts";
import { readNext } from "./next-owner.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { failureText } from "./text.ts";
import { isDrive, type ReadRecord, writeRecord } from "./launches.ts";
import { endedRow, endTime, hasEnded, insertRow } from "./log.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { DrivenPr } from "./types.ts";

export interface EndContext {
  /** Every launch record this tick read, for the takeovers that replaced one. */
  all: ReadRecord[];
  /** The repository's driven pull requests as this tick read them; `null` when the forge was not read. */
  drives: DrivenPr[] | null;
  /** Whether a pull request merged (true) or closed (false); `null` when that cannot be read. */
  merged: (pr: number) => Promise<boolean | null>;
  nowIso: string;
  root?: string;
}

/** A drive's ledger round at its end: the ledger this tick read, else the last round a sample recorded. */
function endRound(r: ReadRecord, drives: DrivenPr[] | null): number | null {
  const round = drives?.find((d) => d.number === r.record.pr)?.evidence.round;
  if (typeof round === "number") return round;
  return r.record.samples?.at(-1)?.round ?? null;
}

/** Write the ended row of each record in `records` that ended and has none yet; returns what failed. */
export async function logEnded(
  records: ReadRecord[],
  ctx: EndContext,
): Promise<string[]> {
  const failed: string[] = [];
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
      const db = stateDb(ctx.root);
      inTransaction(db, () => {
        const current = db
          .query("SELECT result, result_next FROM launches WHERE id = ?")
          .get(record.id) as {
          result: ReadRecord["result"];
          result_next: string | null;
        } | null;
        if (current === null)
          throw new Defect("the launch record disappeared before logging");
        const fresh = {
          ...r,
          result: current.result,
          next: readNext(current.result_next),
        };
        const row = endedRow(
          fresh,
          endedAt,
          { takenOver, merged },
          isDrive(record) ? endRound(r, ctx.drives) : null,
        );
        writeRecord({ ...record, endedAt }, ctx.root);
        insertRow(db, row);
      });
      record.endedAt = endedAt;
    } catch (error) {
      failed.push(
        `the outcome row of launch record ${record.id} could not be written: ${failureText(error)}`,
      );
    }
  }
  return failed;
}
