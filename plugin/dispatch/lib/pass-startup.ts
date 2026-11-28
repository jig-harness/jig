/**
 * How a pass's start reads for its account once it exits: whether it worked,
 * died at its start (signed out, at its usage limit, or for no stated
 * cause, counted toward the account's breaker) or stopped later at its usage
 * limit.
 */
import { swallow } from "../../shared/errors.ts";
import { isoFromMs } from "../../shared/time.ts";
import {
  recordAccountStartupProblem,
  recordStartupDeath,
  recordWorkingStartup,
} from "./account-startup.ts";
import { forgetClaudeSignIn } from "./claude-sign-in.ts";
import { DEFAULT_STARTUP_THRESHOLD } from "./failures.ts";
import { isInteractive, type LaunchRecord, readResult } from "./launches.ts";
import type { Ran } from "./run-stage.ts";
import {
  failedStartup,
  passedStartupWindow,
  quickStartupDeath,
  readsStartup,
  type SignInPhrase,
  type StartupFailure,
  usageNotice,
} from "./session-startup.ts";

/** Whether the wrapper runs a record's stage as a pass of its own: a follow-up's or a pickup's, under its own deadline, its last question kept. */
export function ownPass(record: LaunchRecord): boolean {
  return (
    record.action === "steward" ||
    record.action === "followup" ||
    (record.action === "pickup" && !isInteractive(record))
  );
}

/**
 * Evaluate account startup before the exit hands its slot back to the tick.
 * Earlier progress (a recorded result, a captured question, or running past
 * the startup window) marks the account working and suppresses quick-startup
 * heuristics, while still checking terminal quota evidence on a nonzero exit
 * so the account is walled without discarding the recorded result or question.
 */
export function startupOf(
  record: LaunchRecord,
  ran: Ran,
): {
  startup?: StartupFailure;
  phrase?: SignInPhrase;
} {
  if (
    !ownPass(record) ||
    !readsStartup(record.vendor) ||
    ran.started === undefined ||
    ran.exited === undefined
  )
    return {};
  const { started, exited } = ran;
  const worked =
    readResult(record.id) !== null || ran.code === 0 || Boolean(ran.said);
  if (worked || passedStartupWindow(started, exited)) {
    recordWorkingStartup(record, isoFromMs(started));
    return usageNotice(record, ran.code, startupOutputOf(ran)) !== undefined
      ? { startup: "quota" }
      : {};
  }
  if (!quickStartupDeath(record, ran.code, started, exited)) return {};
  return quickStartupOf(record, ran, started, exited);
}

/** A quick startup death read for its class, counted toward the account's breaker. */
function quickStartupOf(
  record: LaunchRecord,
  ran: Ran,
  started: number,
  exited: number,
): {
  startup?: StartupFailure;
  phrase?: SignInPhrase;
} {
  let phrase: SignInPhrase | undefined;
  const startup = failedStartup(
    record,
    ran.code,
    started,
    startupOutputOf(ran),
    exited,
    (found) => {
      phrase = found;
    },
    ran.head,
  );
  const threshold = record.startupFailureThreshold ?? DEFAULT_STARTUP_THRESHOLD;
  const deaths = recordStartupDeath(
    record,
    startup ?? "died",
    isoFromMs(started),
    threshold,
  );
  const at = isoFromMs(exited);
  if (startup === "sign-in") {
    recordAccountStartupProblem(record, "sign-in", at);
    try {
      forgetClaudeSignIn(record.configDir);
    } catch (error) {
      swallow(error, "the cached sign-in probe could not be dropped");
    }
    return phrase === undefined ? { startup } : { startup, phrase };
  }
  if (startup !== "quota" && deaths >= threshold) {
    recordAccountStartupProblem(record, "breaker", at);
    return { startup: "breaker" };
  }
  return startup === undefined ? {} : { startup };
}

/** What a stage printed at its start, where a vendor's usage notice would be. */
export function startupOutputOf(ran: Ran): string {
  return ran.startupOutput ?? ran.output ?? "";
}
