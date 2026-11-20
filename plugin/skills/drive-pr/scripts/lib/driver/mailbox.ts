/** Wait for mailbox directives without ignoring lock takeover or the pause deadline. */
import { driverRuntime } from "./runtime.ts";

import { foldGateState } from "./../state/mailbox.ts";

import { ackDirective, stopFor } from "./../state/mailbox-stop.ts";

import { isDigits, sleep } from "./../cli.ts";

import {
  MAILBOX_POLL_SECONDS,
  MAILBOX_PAUSE_TIMEOUT_EXIT,
  MAILBOX_STOPPED_EXIT,
  SINGLE_INSTANCE_LOCK_EXIT,
  TAKEN_OVER_EXIT,
} from "./settings.ts";

type MailboxCheckpoint =
  | "clear"
  | "resumed"
  | "stopped"
  | "pause-timeout"
  | "unreadable"
  | "compromised"
  | "taken-over";

/** The mailbox a driver reads, and the generation an addressed `stop` must name to end it. */
export interface MailboxWatch {
  readonly dir: string;
  readonly pr: string;
  readonly generation: number;
}

/**
 * Keep the driver and its heartbeat alive while a pause is active: the lock
 * timer refreshes the locks, and `renew` (the ledger's `ledgerRenewal`) is
 * called on every poll while paused, since a pause may last past the ledger's
 * lease window. A renewal that names an exit (another clone's newer claim)
 * ends the wait as `taken-over`.
 *
 * The driver acknowledges the directive it acts on in the outbox: the
 * `stop` that ends it, and the `pause` it starts holding at.
 */
export async function waitAtMailboxCheckpoint(
  watch: MailboxWatch,
  pauseMaxSec: number,
  renew: () => Promise<number | null> = async () => null,
): Promise<MailboxCheckpoint> {
  let pausedAt: number | null = null;
  for (;;) {
    if (driverRuntime.compromised !== "") return "compromised";
    const directive = await readMailboxDirective(watch);
    if (directive === "clear") return pausedAt === null ? "clear" : "resumed";
    if (directive !== "paused") return directive;
    pausedAt ??= pauseStarted(watch.pr);
    const ended = await whilePaused(watch.pr, pausedAt, pauseMaxSec, renew);
    if (ended !== null) return ended;
  }
}

/** `DRIVE_PR_PAUSE_MAX_SEC`: how long a mailbox pause is waited for, 1800 seconds unless it names 1 to 86400. */
export function pauseMaxSeconds(): number {
  const raw = process.env.DRIVE_PR_PAUSE_MAX_SEC ?? "1800";
  return isDigits(raw) && Number(raw) >= 1 && Number(raw) <= 86400
    ? Number(raw)
    : 1800;
}

/**
 * The mailbox checkpoint as the exit a driver stops with, or `clear` /
 * `resumed` when it goes on: the ordinary stop, pause and compromised-lock
 * semantics every wait of the drive shares, the attach's wait included.
 */
export async function mailboxCheckpointOrExit(
  watch: MailboxWatch,
  renew: () => Promise<number | null> = async () => null,
): Promise<"clear" | "resumed" | number> {
  const outcome = await waitAtMailboxCheckpoint(
    watch,
    pauseMaxSeconds(),
    renew,
  );
  switch (outcome) {
    case "clear":
    case "resumed":
      return outcome;
    case "stopped":
      return MAILBOX_STOPPED_EXIT;
    case "pause-timeout":
      return MAILBOX_PAUSE_TIMEOUT_EXIT;
    case "compromised":
      console.error(
        `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver at a mailbox checkpoint — stopping.`,
      );
      return SINGLE_INSTANCE_LOCK_EXIT;
    case "unreadable":
      return 1;
    case "taken-over":
      return TAKEN_OVER_EXIT;
  }
}

function pauseStarted(pr: string): number {
  console.error(
    `drive.ts: PR #${pr} paused by mailbox directive; waiting for resume --target pause (stop also ends the wait).`,
  );
  return performance.now();
}

/** One poll of an active pause: how it ended, or `null` once slept. */
async function whilePaused(
  pr: string,
  pausedAt: number,
  pauseMaxSec: number,
  renew: () => Promise<number | null>,
): Promise<"pause-timeout" | "taken-over" | null> {
  if (performance.now() - pausedAt >= pauseMaxSec * 1000) {
    console.error(
      `drive.ts: PR #${pr} remained paused for ${pauseMaxSec}s; releasing the drive locks. Re-arm after resuming.`,
    );
    return "pause-timeout";
  }
  if ((await renew()) !== null) return "taken-over";
  await sleep(Math.min(MAILBOX_POLL_SECONDS, pauseMaxSec));
  return null;
}

/** The directives each driver generation already acknowledged, so a pause polled again is acknowledged once. */
const acknowledged = new Set<string>();

/**
 * Acknowledge `id` once the append is durable; a failed append is said, not
 * remembered, so the next poll tries again, and does not stop the drive.
 * Whether `id` is acknowledged by now.
 */
async function acknowledge(watch: MailboxWatch, id: string): Promise<boolean> {
  const key = `${watch.generation}:${id}`;
  if (acknowledged.has(key)) return true;
  try {
    await ackDirective(watch.dir, watch.pr, id, watch.generation);
    acknowledged.add(key);
    return true;
  } catch (error) {
    console.error(
      `drive.ts: could not acknowledge mailbox directive ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Tries a stop's acknowledgement gets before the drive ends without it. */
const STOP_ACK_ATTEMPTS = 3;

async function readMailboxDirective(
  watch: MailboxWatch,
): Promise<"paused" | "clear" | "stopped" | "unreadable"> {
  const gate = foldGateState(watch.dir, watch.pr);
  if (!gate.ok) {
    console.error(`drive.ts: mailbox gate state unreadable: ${gate.why}`);
    return "unreadable";
  }
  const stop = stopFor(gate.state, watch.generation, false);
  if (stop !== null) {
    console.error(
      `drive.ts: stop requested for PR #${watch.pr} (${stop}); ending at a safe round boundary.`,
    );
    for (let attempt = 1; attempt <= STOP_ACK_ATTEMPTS; attempt++) {
      if (await acknowledge(watch, stop)) break;
      if (attempt === STOP_ACK_ATTEMPTS)
        console.error(
          `drive.ts: ending for stop ${stop} WITHOUT its acknowledgement in the outbox after ${STOP_ACK_ATTEMPTS} attempts.`,
        );
      else await sleep(1);
    }
    return "stopped";
  }
  const pause = gate.state.pause;
  if (!pause.active) return "clear";
  if (pause.by !== null) await acknowledge(watch, pause.by);
  return "paused";
}
