/**
 * The tick's part in ending what a run left: on a tick with `--apply`, each
 * launch record that ended, its exit recorded or its wrapper gone without
 * one, is handed to the session runtime's `endRun` once, and the record
 * keeps when (`runEndedAt`), so a later tick does not ask again. On Orca
 * that closes the run tab recorded for the launch by the run-tab idle
 * checks, so a terminal someone typed into stays.
 *
 * A wrapper that recorded its exit closes its own tab, and its tab's record
 * goes with it, so the runtime finds nothing left; the call is for a run
 * whose wrapper died, before or after the stage's exit was recorded. A
 * record whose exit is younger than `SETTLE_MS` waits for a later tick, so
 * the wrapper's own closer goes first. A runtime that throws instead of
 * answering leaves the record unmarked, so a later tick asks again; one
 * that answers is not asked again, whatever it left, which `jig gc`'s
 * collection then closes once idle. A report changes nothing a run left:
 * a tick without `--apply` asks nothing, and marks nothing.
 */
import { failureText } from "./text.ts";
import { type ReadRecord, targetOf, writeRecord } from "./launches.ts";
import { hasEnded } from "./log.ts";
import type { EndedRun, RuntimeReceipt } from "./runtime/port.ts";
import type { EndRunOutcome } from "./types.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";

/** How long after a recorded exit the wrapper's own closer has to close its tab before the tick asks. */
export const SETTLE_MS = 60_000;

/**
 * A runtime's `endRun` within the time the tick has left: `null` once that
 * time is spent, which asks nothing and leaves the record for a later tick.
 */
export type EndRun = (run: EndedRun) => Promise<RuntimeReceipt> | null;

/** Whether the tick asks the runtime to end `r`'s run now. */
function due(r: ReadRecord, nowMs: number): boolean {
  if (!hasEnded(r) || r.record.runEndedAt !== undefined) return false;
  if (r.state.kind !== "ended") return true;
  const at = parseMs(r.state.exit.at);
  return !Number.isFinite(at) || nowMs - at >= SETTLE_MS;
}

/** Ask the runtime to end what each ended run of `records` left, once; what it ended or left, a run that left nothing unreported. */
export async function endRuns(
  records: ReadRecord[],
  endRun: EndRun,
  nowMs: number,
  root?: string,
): Promise<EndRunOutcome[]> {
  const outcomes: EndRunOutcome[] = [];
  for (const r of records) {
    if (!due(r, nowMs)) continue;
    const { record } = r;
    const about = { record: record.id, target: targetOf(record) };
    let receipt: RuntimeReceipt;
    try {
      const asked = endRun({ id: record.id, workspace: record.workspace });
      if (asked === null) break;
      receipt = await asked;
    } catch (error) {
      // No answer: the record stays unmarked, so a later tick asks again.
      outcomes.push({
        ...about,
        outcome: "left",
        detail: `${failureText(error)}; a later tick asks again`,
      });
      continue;
    }
    try {
      const runEndedAt = isoFromMs(nowMs);
      writeRecord({ ...record, runEndedAt }, root);
      record.runEndedAt = runEndedAt;
    } catch (error) {
      outcomes.push({
        ...about,
        outcome: "left",
        detail: `${receipt.detail}; that it was asked could not be recorded, so a later tick asks again: ${failureText(error)}`,
      });
      continue;
    }
    if (receipt.nothingLeft === true) continue;
    outcomes.push({
      ...about,
      outcome: receipt.ok ? "ended" : "left",
      detail: receipt.detail,
    });
  }
  return outcomes;
}
