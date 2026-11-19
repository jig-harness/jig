/**
 * What the cancelled-CI recovery makes of a forge read that failed. A failure
 * waiting can clear (a timeout, a rate limit, a fault or silence of the forge)
 * says nothing about the head, so it is never `unknown`: the read is asked once
 * more, and a read that still fails stops the drive with the exit the line
 * re-arms. A failure waiting cannot clear, and an answer that does not read,
 * stay `unknown`.
 */
import type { Failure, Outcome } from "../../../../shared/outcome.ts";
import {
  clearsByWaiting,
  type FailureClass,
} from "../../../../shared/outbound/failure.ts";
import { retryAttempts } from "../../../../shared/retry.ts";
import type { Recovery } from "./cancelled-recovery.ts";
import { testPacing } from "./cli.ts";
import type { ForgeReadCode } from "./forge-read.ts";
import { DRIVE_EXIT } from "./status/terminal-states.ts";

/** The first request and one more: a failed read is sent once again, never in a loop. */
const READ_ATTEMPTS = 2;

/** The wait before the second request, before its jitter. */
const READ_RETRY_MS = 2_000;

/** A read that kept failing in a way waiting can clear. */
export interface RecoveryReadFailure {
  /** Which read, as a person reads it. */
  read: string;
  class: FailureClass;
  reason: string;
}

/**
 * The recovery's answer on a live head. `listing-cut-short` is a check-runs
 * listing a deadline or its page bound ended: nothing was established, and the
 * drive stops as `CHECK_RUNS_UNREADABLE`.
 */
export type LiveRecovery = Recovery | "listing-cut-short" | RecoveryReadFailure;

export type RecoveryRead<T> =
  | { ok: true; value: T }
  | { ok: false; answer: "unknown" | RecoveryReadFailure };

/** A rate limit is not asked again: nothing is sent before the time it names. */
const asksAgain = (code: ForgeReadCode): boolean =>
  code !== "malformed" && code !== "rate-limited" && clearsByWaiting(code);

function failedAnswer(
  read: string,
  failure: Failure<ForgeReadCode>,
): "unknown" | RecoveryReadFailure {
  const { code, reason } = failure;
  return code !== "malformed" && clearsByWaiting(code)
    ? { read, class: code, reason }
    : "unknown";
}

/** `ask`, sent once more when it failed in a way that may clear; every failure is logged. */
export async function recoveryRead<T>(
  read: string,
  ask: () => Promise<Outcome<T, ForgeReadCode>>,
  /** True when the failure just seen cannot clear by asking again, such as a listing past its page bound. */
  settled: () => boolean = () => false,
  /** Milliseconds between attempts, in place of the environment's pacing (for a test). */
  retryMs?: number,
): Promise<RecoveryRead<T>> {
  const wait =
    retryMs ?? testPacing("DRIVE_PR_RECOVERY_READ_RETRY_MS", READ_RETRY_MS, 10);
  let last: Failure<ForgeReadCode> | null = null;
  for await (const attempt of retryAttempts({
    attempts: READ_ATTEMPTS,
    baseMs: wait,
    maxMs: wait,
  })) {
    const outcome = await ask();
    if (outcome.ok) return outcome;
    last = outcome.failure;
    console.error(
      `cancelled CI recovery: the ${read} read failed (attempt ${attempt} of ${READ_ATTEMPTS}, ${last.code}): ${last.reason}`,
    );
    if (settled() || !asksAgain(last.code)) break;
  }
  return {
    ok: false,
    answer: last === null ? "unknown" : failedAnswer(read, last),
  };
}

/** The recovery's answer in a line of the drive's log. */
export function recoveryLabel(recovery: LiveRecovery): string {
  return typeof recovery === "string"
    ? recovery
    : `the ${recovery.read} read failed (${recovery.class})`;
}

/**
 * The exit a recovery's answer ends the drive with, `null` when it does not.
 * A read that kept failing established nothing and spent no re-run, so the
 * drive stops as not settled and the line re-arms it after a wait.
 */
export function recoveryExit(recovery: LiveRecovery): number | null {
  if (recovery === "parked") return DRIVE_EXIT.HITL_PARKED;
  if (recovery === "unknown") return DRIVE_EXIT.INDETERMINATE;
  if (recovery === "listing-cut-short") return DRIVE_EXIT.CHECK_RUNS_UNREADABLE;
  if (typeof recovery === "string") return null;
  console.error(
    `cancelled CI recovery: ${recoveryLabel(recovery)}: ${recovery.reason}; stopping for a re-arm after a wait`,
  );
  return DRIVE_EXIT.NOT_SETTLED;
}
