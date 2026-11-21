/** Shared stop details and the reset wait during the converged CI watch. */
import { isoFromMs } from "../../../../../shared/time.ts";
import { sleep } from "../cli.ts";
import { type ForgeLimit, limitLine, limitPlan } from "../forge-limit.ts";
import { DRIVE_EXIT } from "../status/terminal-states.ts";
import { driverRuntime } from "./runtime.ts";
import { SINGLE_INSTANCE_LOCK_EXIT } from "./settings.ts";

/** Seconds as a person reads a wait. */
export function seconds(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

/** Record `limit` as the stop's reset and say so, and why the drive does not wait for it; the exit to stop with. */
export function stopOnLimit(
  pr: string,
  limit: ForgeLimit | null,
  why = "further off than the drive waits (DRIVE_PR_RATE_LIMIT_WAIT)",
): number {
  driverRuntime.stopLimitedUntil =
    limit === null ? null : isoFromMs(limit.until);
  console.error(
    limit === null
      ? `drive.ts: PR #${pr}: the forge's rate limit for this credential is spent, and its reset was not reported; stopping FORGE_RATE_LIMITED (exit ${DRIVE_EXIT.FORGE_RATE_LIMITED}). The line drives it again later.`
      : `drive.ts: PR #${pr}: ${limitLine(limit)}, ${why}; stopping FORGE_RATE_LIMITED (exit ${DRIVE_EXIT.FORGE_RATE_LIMITED}). The line drives it again after the reset.`,
  );
  return DRIVE_EXIT.FORGE_RATE_LIMITED;
}

/** How many resets in a row the drive waits for, in the driver: a limit spent again at every reset is not waited out for good. */
export const LIMIT_WAITS = 3;

/** Wait for a reset after convergence. The watch renews its lease and checks ownership before judging CI again. */
export async function waitForWatchReset(
  pr: string,
  limit: ForgeLimit,
  waits: number,
): Promise<number | "continue"> {
  const plan = limitPlan(limit);
  if (plan.action === "stop") return stopOnLimit(pr, limit);
  if (waits >= LIMIT_WAITS)
    return stopOnLimit(
      pr,
      limit,
      "spent again after every reset the watch waited for",
    );
  console.error(
    `drive.ts: PR #${pr}: ${limitLine(limit)}; waiting ${seconds(plan.ms)} for the reset, sending nothing before it.`,
  );
  const abort = new AbortController();
  driverRuntime.quotaSleepAbort = abort;
  try {
    if (driverRuntime.compromised === "")
      await sleep(plan.ms / 1000, abort.signal);
  } finally {
    driverRuntime.quotaSleepAbort = null;
  }
  if (driverRuntime.compromised !== "") return SINGLE_INSTANCE_LOCK_EXIT;
  console.error(
    `drive.ts: PR #${pr}: the forge's rate limit has reset; reading the pull request again.`,
  );
  return "continue";
}
