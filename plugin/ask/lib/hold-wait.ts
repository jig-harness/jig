/**
 * What a drive waits on while a launch nobody can show running holds it: the
 * hold, named with its holder, why its process is unknown and how long it
 * has held the drive. Past the dispatcher's bound
 * (`dispatch/lib/stranded-holds.ts`), or with no dispatcher known to raise
 * it, the hold is a person's to settle. A pending launch stays the
 * dispatcher's: it launches the record again or reports it stuck. A drive
 * the hold does not keep from going on (one done, running, refused or
 * stopped by a person, a merged pull request's) waits on what its class
 * says until the bound, and past it on the hold, which keeps a launch slot
 * of its account taken, once it is this machine's record (and, where the
 * drive's driver may still run, every process of it is proved gone).
 */
import type { ReadRecord } from "../../dispatch/lib/launches.ts";
import {
  clearBlock,
  heldStopSinceMs,
  heldUpByLaunch,
  needsProof,
  provedGone,
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

/** Whether the holder is this machine's record of unknown state, every process of which is proved gone where `proof` asks it. */
function ownRecord(
  holder: Holder,
  read: ReadRecord | null,
  proof: boolean,
): boolean {
  return (
    holder.local?.record !== undefined &&
    read?.record.id === holder.local.record &&
    read.state.kind === "unknown" &&
    (!proof || provedGone(read.state))
  );
}

/** How a person settles the hold. */
function settleWords(
  holder: Holder,
  read: ReadRecord | null,
  heldUp: boolean,
): string {
  const record = holder.local?.record;
  if (record === undefined)
    return "check its host, and once no session runs for the launch settle its record there";
  const clear = `jig dispatch clear ${record} ${heldUp ? "lets the next tick act on the drive" : "frees the launch slot it holds"}`;
  const blocked =
    read?.state.kind === "unknown" ? clearBlock(read.state) : null;
  return blocked === null
    ? `once no session runs for it, ${clear}`
    : `${blocked}; then ${clear}`;
}

/** The wait on a hold of unknown process; `null` when the holder runs, or the hold is not what the drive waits on yet. `stoppedAt` is the drive's last heartbeat, or a merged pull request's merge. */
export function heldStopWait(
  holder: Holder | "none",
  placed: LedgerClass,
  stoppedAt: string,
  facts: HoldFacts,
): WaitsOn | null {
  if (holder === "none" || holder.process === "alive") return null;
  const heldUp = heldUpByLaunch(placed);
  if (!heldUp && !ownRecord(holder, facts.record, needsProof(placed)))
    return null;
  const since = heldStopSinceMs(holder.since ?? "", stoppedAt, placed);
  const age = currentMs() - since;
  const held = Number.isFinite(since)
    ? `${holderWords(holder)}; it has held the drive for ${spanText(age)}, since ${isoFromMs(since)}`
    : holderWords(holder);
  if (facts.record?.state.kind === "pending")
    return heldUp
      ? {
          waiting: `${held}; the dispatcher launches it again or reports it stuck`,
        }
      : null;
  if (Number.isFinite(since) && age >= STRANDED_HOLD_MS)
    return personWait(
      "settle the launch that holds the drive",
      `${held}, past ${STRANDED_HOLD_TEXT}${heldUp ? "" : ", and keeps a launch slot of its account taken"}: ${settleWords(holder, facts.record, heldUp)}`,
    );
  if (!heldUp) return null;
  // A launch record of this machine's own shows a dispatcher runs here.
  if (!facts.dispatched && holder.local?.record === undefined)
    return personWait(
      "settle the launch that holds the drive",
      `${held}; no dispatcher is known to raise it: ${settleWords(holder, facts.record, heldUp)}`,
    );
  return {
    waiting: `${held}; nothing acts on the drive while it holds, and past ${STRANDED_HOLD_TEXT} it is raised to a person`,
  };
}
