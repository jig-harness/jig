/**
 * The tick's part of the outcome log (`log.ts`) for launch records: each
 * record that ended gets its ended row once. The row's time is kept on the
 * record (`endedAt`) before the row is appended, and the record is marked
 * (`logged`) after, so a tick that stopped in between writes the same row
 * into the same month's file, where the append finds its key and writes
 * nothing twice.
 */
import { failureText } from "./text.ts";
import { isDrive, type ReadRecord, writeRecord } from "./launches.ts";
import { appendRow, endedRow, endTime, hasEnded } from "./log.ts";
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

/** Append the ended row of each record in `records` that ended and has none yet; returns what failed. */
export async function logEnded(
  records: ReadRecord[],
  ctx: EndContext,
): Promise<string[]> {
  const failed: string[] = [];
  for (const r of records) {
    const { record } = r;
    if (!hasEnded(r) || record.logged === true) continue;
    try {
      if (record.endedAt === undefined) {
        record.endedAt = endTime(r, ctx.nowIso);
        writeRecord(record, ctx.root);
      }
      const exit = r.state.kind === "ended" ? r.state.exit.code : null;
      const merged =
        isDrive(record) && exit === 5 && record.pr !== null
          ? await ctx.merged(record.pr)
          : null;
      const takenOver = ctx.all.some((x) => x.record.replaces === record.id);
      appendRow(
        endedRow(
          r,
          record.endedAt,
          { takenOver, merged },
          isDrive(record) ? endRound(r, ctx.drives) : null,
        ),
        ctx.root,
      );
      record.logged = true;
      writeRecord(record, ctx.root);
    } catch (error) {
      failed.push(
        `the outcome row of launch record ${record.id} could not be written: ${failureText(error)}`,
      );
    }
  }
  return failed;
}
