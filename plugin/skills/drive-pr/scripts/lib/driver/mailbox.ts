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
  | "compromised";

/**
 * Keep the driver and its heartbeat alive while a pause is active: the lock
 * timer refreshes the locks, and `renew` (the ledger's `ledgerRenewal`) is
 * called on every poll while paused, since a pause may last past the ledger's
 * lease window.
 */
export async function waitAtMailboxCheckpoint(
  dir: string,
  pr: string,
  pauseMaxSec: number,
  renew?: () => Promise<void>,
): Promise<MailboxCheckpoint> {
  let pausedAt: number | null = null;
  for (;;) {
    if (driverRuntime.compromised !== "") return "compromised";
    const directive = readMailboxDirective(dir, pr);
    if (directive === "clear") return pausedAt === null ? "clear" : "resumed";
    if (directive !== "paused") return directive;
    if (pausedAt === null) {
      pausedAt = performance.now();
      console.error(
        `drive.ts: PR #${pr} paused by mailbox directive; waiting for resume --target pause (stop also ends the wait).`,
      );
    }
    if (performance.now() - pausedAt >= pauseMaxSec * 1000) {
      console.error(
        `drive.ts: PR #${pr} remained paused for ${pauseMaxSec}s; releasing the drive locks. Re-arm after resuming.`,
      );
      return "pause-timeout";
    }
    await renew?.();
    await sleep(Math.min(MAILBOX_POLL_SECONDS, pauseMaxSec));
  }
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
