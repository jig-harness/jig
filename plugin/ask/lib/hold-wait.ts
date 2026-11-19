/**
 * What a drive waits on while a launch nobody can show running holds it: the
 * hold, named with its holder, why its process is unknown and how long it
 * has held the drive. Past the dispatcher's bound
 * (`dispatch/lib/stranded-holds.ts`), or with no dispatcher known to raise
 * it, the hold is a person's to settle. A pending launch stays the
 * dispatcher's: it launches the record again or reports it stuck.
 */
import type { ReadRecord } from "../../dispatch/lib/launches.ts";
import {
  clearBlock,
  heldStopSinceMs,
  heldUpByLaunch,
  STRANDED_HOLD_MS,
  STRANDED_HOLD_TEXT,
} from "../../dispatch/lib/stranded-holds.ts";
import type { LedgerClass } from "../../dispatch/lib/types.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";
import { type Holder, personWait, type WaitsOn } from "./answer.ts";

/** What besides the holder decides the wait. */
export interface HoldFacts {
  /** Whether a dispatcher is known to act on the pull request. */
  dispatched: boolean;
  /** This machine's launch record that holds the drive, if one does. */
  record: ReadRecord | null;
}

/** A span of time as a person reads it, to the minute. */
function spanText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
}

/** The holder in words: its launch, where it is, its record and why its process is what it is. */
function holderWords(holder: Holder): string {
  const where = holder.host === "unknown" ? "an unknown host" : holder.host;
  const record = holder.local?.record;
  return `held by the ${holder.stage} launch on ${where}${record === undefined ? "" : ` (launch record ${record})`}, whose process is ${holder.process}: ${holder.why}`;
}

/** How a person settles the hold. */
function settleWords(holder: Holder, read: ReadRecord | null): string {
  const record = holder.local?.record;
  if (record === undefined)
    return "check its host, and once no session runs for the launch settle its record there";
  const clear = `jig dispatch clear ${record} lets the next tick act on the drive`;
  const blocked =
    read?.state.kind === "unknown" ? clearBlock(read.state) : null;
  return blocked === null
    ? `once no session runs for it, ${clear}`
    : `${blocked}; then ${clear}`;
}

/** The wait on a hold that keeps a drive from going on; `null` when the holder runs, or the hold is not what the drive waits on. */
export function heldStopWait(
  holder: Holder | "none",
  placed: LedgerClass,
  stoppedAt: string,
  facts: HoldFacts,
): WaitsOn | null {
  if (holder === "none" || holder.process === "alive") return null;
  if (!heldUpByLaunch(placed)) return null;
  const since = heldStopSinceMs(holder.since ?? "", stoppedAt);
  const age = currentMs() - since;
  const held = Number.isFinite(since)
    ? `${holderWords(holder)}; it has held the drive for ${spanText(age)}, since ${isoFromMs(since)}`
    : holderWords(holder);
  if (facts.record?.state.kind === "pending")
    return {
      waiting: `${held}; the dispatcher launches it again or reports it stuck`,
    };
  if (Number.isFinite(since) && age >= STRANDED_HOLD_MS)
    return personWait(
      "re-arm",
      `${held}, past ${STRANDED_HOLD_TEXT}: ${settleWords(holder, facts.record)}`,
    );
  // A launch record of this machine's own shows a dispatcher runs here.
  if (!facts.dispatched && holder.local?.record === undefined)
    return personWait(
      "re-arm",
      `${held}; no dispatcher is known to raise it: ${settleWords(holder, facts.record)}`,
    );
  return {
    waiting: `${held}; nothing acts on the drive while it holds, and past ${STRANDED_HOLD_TEXT} it is raised to a person`,
  };
}
