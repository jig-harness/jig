/**
 * The driver's side of a mailbox `stop`: which directive ends driver
 * generation `g`, and the `ack` the driver appends to the outbox once it acted
 * on one, so a sender sees the stop took effect.
 *
 * A driver generation is a number the drive database draws for each driver
 * of a pull request in a clone (`nextDriverGeneration`), printed at the
 * driver's start and carried in its lock's claim (`ClaimDiag.generation`), so
 * `drives.ts` can address it. A `stop` naming that generation ends that driver
 * alone; a later driver draws another number and ignores it. A `stop` naming
 * none ends every later driver too, until `resume --target stop`.
 *
 * Two strengths, one directive: an addressed stop a sender writes with
 * `mailbox.ts send … --generation g` ends the driver at its next round
 * boundary (exit `MAILBOX_STOPPED`); the one `drives.ts --stop` writes also
 * carries `now`, which the driver's stop watch (`lib/driver/lifecycle.ts`)
 * reads every quarter second and answers by cancelling the active pass and
 * stopping at once.
 */
import { resolve } from "node:path";
import { canonicalPr } from "./store.ts";
import { type DriveDb, nextCount } from "./db.ts";
import {
  appendOutboxRecord,
  foldGateState,
  type GateState,
  mailboxDir,
  outboxRecordsForPr,
} from "./mailbox.ts";

/** Draw the next driver generation of `pr` in this clone: 1 for its first driver here. */
export function nextDriverGeneration(drive: DriveDb, pr: string): number {
  return nextCount(
    drive,
    `driver-generation:${drive.clone}:${canonicalPr(pr)}`,
  );
}

/**
 * The id of the `stop` that ends driver `generation`, `null` when none does.
 * `now` picks the strength: the stops to act on at once (`drives.ts --stop`'s),
 * or the ones a round boundary acts on (an addressed stop without `now`, and
 * a stop naming no generation).
 */
export function stopFor(
  state: GateState,
  generation: number,
  now: boolean,
): string | null {
  const addressed = state.addressed.find(
    (s) => s.generation === generation && s.now === now,
  );
  if (addressed !== undefined) return addressed.by;
  return !now && state.stop.active ? state.stop.by : null;
}

/** The `now` stop addressed to driver `generation` in `dir`, `null` when none or the inbox does not read. */
export function immediateStop(
  dir: string,
  pr: string,
  generation: number,
): string | null {
  const gate = foldGateState(dir, pr);
  return gate.ok ? stopFor(gate.state, generation, true) : null;
}

/** Append the driver's acknowledgement that it acted on directive `id`, as driver `generation`. */
export async function ackDirective(
  dir: string,
  pr: string,
  id: string,
  generation: number,
): Promise<void> {
  await appendOutboxRecord(dir, {
    id,
    ts: new Date().toISOString(),
    pr,
    status: "ack",
    generation,
  });
}

/** Whether the outbox holds the driver's `ack` of directive `id`. */
export function directiveAcked(dir: string, pr: string, id: string): boolean {
  const out = outboxRecordsForPr(dir, pr);
  return out.ok && out.records.some((r) => r.id === id && r.status === "ack");
}

/**
 * The mailbox of the driver working `worktree`: where `drives.ts --stop`
 * writes, `$DRIVE_PR_MAILBOX_DIR` when set, as the driver resolves its own;
 * `''` when the claim names no working tree to find it in.
 */
export function driverMailboxDir(worktree: string): string {
  const override = process.env.DRIVE_PR_MAILBOX_DIR ?? "";
  if (override !== "") return resolve(override);
  return worktree === "" ? "" : mailboxDir(worktree);
}
