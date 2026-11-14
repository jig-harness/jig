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
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalPr } from "./store.ts";
import { type DriveDb, nextCount } from "./db.ts";
import {
  appendOutboxRecord,
  foldGateState,
  inboxPath,
  type GateState,
  mailboxDir,
  outboxRecordsForPr,
  readInboxMessages,
} from "./mailbox.ts";
import { currentIso } from "../../../../../shared/time.ts";

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

/**
 * `immediateStop` for a poll that repeats: an inbox whose file is unchanged
 * since a poll that found no stop is not read and folded again. Any change to
 * the file, or a stop found, is read afresh.
 */
export function watchImmediateStop(
  dir: string,
  pr: string,
  generation: number,
): () => string | null {
  let quiet: string | null = null;
  return () => {
    const seen = inboxSignature(dir);
    if (seen !== null && seen === quiet) return null;
    const stop = immediateStop(dir, pr, generation);
    quiet = stop === null ? seen : null;
    return stop;
  };
}

/** The inbox file's identity, size and modification time; `'absent'` when it does not exist, `null` when it cannot be stat-ed. */
function inboxSignature(dir: string): string | null {
  try {
    const s = statSync(inboxPath(dir), { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "absent"
      : null;
  }
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
    ts: currentIso(),
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
 * Whether driver `generation` acknowledged an immediate stop addressed to it
 * (`drives.ts --stop`'s, marked `now`): it acts on the first it finds and
 * exits, so a second operator's concurrent stop is never acknowledged under
 * its own id, and the driver having stopped is what both wait for. Only that
 * acknowledgement counts, because only it is appended once the driver's
 * cooperative cleanup is witnessed (`lib/driver/lifecycle.ts`): a pause's is
 * appended as the driver starts holding, and a round boundary's stop's before
 * the driver exits, so neither proves its registered work ended.
 */
export function generationAcked(
  dir: string,
  pr: string,
  generation: number,
): boolean {
  const immediate = new Set(
    readInboxMessages(dir, pr)
      .messages.filter(
        (m) =>
          m.kind === "directive" &&
          m.command === "stop" &&
          m.generation === generation &&
          m.now === true,
      )
      .map((m) => m.id),
  );
  const out = outboxRecordsForPr(dir, pr);
  return (
    out.ok &&
    out.records.some(
      (r) =>
        r.status === "ack" &&
        r.generation === generation &&
        immediate.has(r.id),
    )
  );
}

/**
 * The mailbox of the driver working `worktree`: where `drives.ts --stop`
 * writes. The driver's own resolved directory when its claim records one
 * (`mailbox`); otherwise, for a claim that predates it, `$DRIVE_PR_MAILBOX_DIR`
 * when set, else the working tree's; `''` when the claim names no working tree
 * to find it in.
 */
export function driverMailboxDir(worktree: string, mailbox = ""): string {
  if (mailbox !== "") return mailbox;
  const override = process.env.DRIVE_PR_MAILBOX_DIR ?? "";
  if (override !== "") return resolve(override);
  return worktree === "" ? "" : mailboxDir(worktree);
}
