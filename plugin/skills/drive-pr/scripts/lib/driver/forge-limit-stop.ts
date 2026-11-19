/**
 * The driver's answer to the forge's spent rate limit (`lib/forge-limit.ts`):
 * a status probe that ended `FORGE_RATE_LIMITED`, or an attach read the limit
 * refused. A reset the drive waits for is waited out, sending nothing before
 * it, and the drive goes on; one further off stops the drive with the reset
 * on its `stop` event, which the dispatcher re-drives it after.
 */
import type { DriveRoundContext } from "./round-context.ts";
import { driverRuntime } from "./runtime.ts";
import { waitBetweenPasses } from "./review-quota.ts";
import { sleep } from "./../cli.ts";
import { SINGLE_INSTANCE_LOCK_EXIT } from "./settings.ts";
import {
  type ForgeLimit,
  type LimitBounds,
  limitLine,
  limitPlan,
  reportedLimit,
} from "./../forge-limit.ts";
import { DRIVE_EXIT } from "./../status/terminal-states.ts";
import { currentMs, isoFromMs } from "../../../../../shared/time.ts";

/** Seconds as a person reads a wait. */
function seconds(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

/** Record `limit` as the stop's reset and say so, and why the drive does not wait for it; the exit to stop with. */
function stopOnLimit(
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

/**
 * A status probe ended `FORGE_RATE_LIMITED`: wait for its reset between
 * passes, keeping the ledger's lease and the mailbox, then read again; or
 * stop on it.
 */
export async function answerForgeLimit(
  context: DriveRoundContext,
  status: Record<string, unknown>,
): Promise<number | "continue"> {
  const limit = reportedLimit(status);
  const plan = limit === null ? null : limitPlan(limit);
  if (limit === null || plan?.action !== "wait")
    return stopOnLimit(context.pr, limit);
  console.error(
    `drive.ts: PR #${context.pr}: ${limitLine(limit)}; waiting ${seconds(plan.ms)} for the reset, sending nothing before it.`,
  );
  const stopped = await waitBetweenPasses(plan.ms, context);
  if (stopped !== null) return stopped;
  // A lost lock cut the wait short: the loop's own top-of-iteration check
  // reports it.
  if (driverRuntime.compromised === "")
    console.error(
      `drive.ts: PR #${context.pr}: the forge's rate limit has reset; reading the pull request again.`,
    );
  return "continue";
}

/**
 * The attach's read met the limit before the round loop starts: wait for a
 * near reset while the attach `mayWait`, else stop. `true` once the reset
 * passed and the attach may read again; the exit to stop with otherwise, a
 * lost lock's included.
 */
export async function attachForgeLimit(
  pr: string,
  limit: ForgeLimit,
  mayWait: boolean,
  bounds: LimitBounds = {},
): Promise<true | number> {
  const plan = limitPlan(limit, currentMs(), bounds);
  if (!mayWait)
    return stopOnLimit(
      pr,
      limit,
      "spent again after every reset the attach waited for",
    );
  if (plan.action !== "wait") return stopOnLimit(pr, limit);
  console.error(
    `drive.ts: PR #${pr}: the attach could not read the pull request: ${limitLine(limit)}; waiting ${seconds(plan.ms)} for the reset, sending nothing before it.`,
  );
  driverRuntime.quotaSleepAbort = new AbortController();
  try {
    await sleep(plan.ms / 1000, driverRuntime.quotaSleepAbort.signal);
  } finally {
    driverRuntime.quotaSleepAbort = null;
  }
  // The heartbeat found a lock recovered by another driver: the tree is no
  // longer this drive's to move.
  if (driverRuntime.compromised !== "") {
    console.error(
      `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver while the attach waited — stopping rather than attaching beside it.`,
    );
    return SINGLE_INSTANCE_LOCK_EXIT;
  }
  return true;
}
