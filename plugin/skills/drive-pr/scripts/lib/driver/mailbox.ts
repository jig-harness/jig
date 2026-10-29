/** Wait for mailbox directives without ignoring lock takeover or the pause deadline. */
import { driverRuntime } from "./runtime.ts";

import { foldGateState } from "./../state/mailbox.ts";

import { sleep } from "./../cli.ts";

import { MAILBOX_POLL_SECONDS } from "./settings.ts";

type MailboxCheckpoint =
  | "clear"
  | "resumed"
  | "stopped"
  | "pause-timeout"
  | "unreadable"
  | "compromised"
  | "taken-over";

/**
 * Keep the driver and its heartbeat alive while a pause is active: the lock
 * timer refreshes the locks, and `renew` (the ledger's `ledgerRenewal`) is
 * called on every poll while paused, since a pause may last past the ledger's
 * lease window. A renewal that names an exit (another clone's newer claim)
 * ends the wait as `taken-over`.
 */
export async function waitAtMailboxCheckpoint(
  dir: string,
  pr: string,
  pauseMaxSec: number,
  renew: () => Promise<number | null> = async () => null,
): Promise<MailboxCheckpoint> {
  let pausedAt: number | null = null;
  for (;;) {
    if (driverRuntime.compromised !== "") return "compromised";
    const directive = readMailboxDirective(dir, pr);
    if (directive === "clear") return pausedAt === null ? "clear" : "resumed";
    if (directive !== "paused") return directive;
    pausedAt ??= pauseStarted(pr);
    const ended = await whilePaused(pr, pausedAt, pauseMaxSec, renew);
    if (ended !== null) return ended;
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

function readMailboxDirective(
  dir: string,
  pr: string,
): "paused" | "clear" | "stopped" | "unreadable" {
  const gate = foldGateState(dir, pr);
  if (!gate.ok) {
    console.error(`drive.ts: mailbox gate state unreadable: ${gate.why}`);
    return "unreadable";
  }
  if (gate.state.stop.active) {
    console.error(
      `drive.ts: stop requested for PR #${pr}; ending at a safe round boundary.`,
    );
    return "stopped";
  }
  return gate.state.pause.active ? "paused" : "clear";
}
