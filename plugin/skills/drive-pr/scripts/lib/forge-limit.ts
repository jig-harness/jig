/**
 * What the drive does when the forge's rate limit for its credential is
 * spent. The outbound layer already knows the class and the reset
 * (`rate-limited`, `until`): a read it refused is never a failure to report
 * as `INDETERMINATE`, and nothing is sent before the reset.
 *
 * - A reset the drive can wait for (within `DRIVE_PR_RATE_LIMIT_WAIT`
 *   seconds, 30 minutes by default) is waited for, and the drive goes on:
 *   the attach reads the pull request again, the round loop runs the status
 *   probe again.
 * - A reset further off stops the drive `FORGE_RATE_LIMITED` (exit `24`),
 *   its stop recording the reset (`until` on its `stop` event), which the
 *   dispatcher re-drives it after, without a person.
 *
 * `drive-status.ts` ends on the limit as soon as one of its own reads meets
 * it (`forgeLimitHeld`), with the reset in its report's `rateLimit`, rather
 * than retrying reads that could only be refused again.
 */
import {
  type ForgeLimit,
  forgeLimitHeld,
} from "../../../../shared/outbound/forge-limit-seen.ts";
import {
  type GhRun,
  ghRunFailure,
} from "../../../../shared/outbound/github.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { currentMs, isoFromMs, parseMs } from "../../../../shared/time.ts";

export { type ForgeLimit, forgeLimitHeld };

/** The longest the drive waits for a reset unless `DRIVE_PR_RATE_LIMIT_WAIT` says otherwise. */
export const RATE_LIMIT_WAIT_SECONDS = 30 * 60;

/** The most `DRIVE_PR_RATE_LIMIT_WAIT` may ask for: a reset further off than a day is not waited for in-process. */
const RATE_LIMIT_WAIT_MAX_SECONDS = 24 * 60 * 60;

/** Past the reset before the drive reads again, so the first read is not refused by a clock a little behind the forge's. */
const RESET_MARGIN_MS = 5_000;

/** How long the drive waits for a spent limit to reset: `DRIVE_PR_RATE_LIMIT_WAIT` seconds, a whole number up to a day; otherwise the default. */
export function rateLimitWaitMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DRIVE_PR_RATE_LIMIT_WAIT ?? "";
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(seconds) && seconds <= RATE_LIMIT_WAIT_MAX_SECONDS
    ? seconds * 1000
    : RATE_LIMIT_WAIT_SECONDS * 1000;
}

/** The limit a run of `gh` met, as the outbound layer classified it; `null` for any other answer. */
export function forgeLimitOf(r: GhRun): ForgeLimit | null {
  const failure = ghRunFailure(r);
  return failure?.code === "rate-limited" && failure.until !== undefined
    ? { until: failure.until, reason: failure.reason }
    : null;
}

/** What the drive does about `limit` at `now`: wait `ms` and read again, or stop on it. */
export type LimitPlan = { action: "wait"; ms: number } | { action: "stop" };

/** How long to wait and how long the drive may: `DRIVE_PR_RATE_LIMIT_WAIT`, and a margin past the reset. */
export interface LimitBounds {
  boundMs?: number;
  marginMs?: number;
}

export function limitPlan(
  limit: Pick<ForgeLimit, "until">,
  now: number = currentMs(),
  { boundMs = rateLimitWaitMs(), marginMs = RESET_MARGIN_MS }: LimitBounds = {},
): LimitPlan {
  const left = Math.max(0, limit.until - now);
  return left <= boundMs
    ? { action: "wait", ms: left + marginMs }
    : { action: "stop" };
}

/** The limit in a line of the drive's log. */
export function limitLine(limit: ForgeLimit): string {
  return `the forge's rate limit for this credential is spent until ${isoFromMs(limit.until)} (${limit.reason})`;
}

/** The limit as `drive-status.ts`'s report carries it: `rateLimit`, the reset as an instant. */
export function reportLimit(limit: ForgeLimit): {
  until: string;
  reason: string;
} {
  return { until: isoFromMs(limit.until), reason: limit.reason };
}

/** The limit a `drive-status.ts` report names; `null` when it names none, or a reset that does not read. */
export function reportedLimit(
  status: Record<string, unknown>,
): ForgeLimit | null {
  const limit = status.rateLimit;
  if (!isRecord(limit) || typeof limit.until !== "string") return null;
  const until = parseMs(limit.until);
  if (!Number.isFinite(until)) return null;
  return {
    until,
    reason: typeof limit.reason === "string" ? limit.reason : "",
  };
}
