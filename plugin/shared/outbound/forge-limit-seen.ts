/**
 * The forge's rate limit as this process last met it: the latest `gh` call
 * the limit refused (`rate-limited`, sent and refused by the forge or held
 * here by the budget), until the reset it named, so a reader that ends on a
 * failed read can tell a spent limit from any other failure without
 * classifying its own text again. A call that succeeds after it clears the
 * record: the limit no longer explains what fails next. Any other failure
 * leaves it as it is.
 *
 * One record per process, never shared: each process sees the calls it sent.
 */
import type { OutboundFailure } from "./failure.ts";
import { currentMs } from "../time.ts";
import { AsyncLocalStorage } from "node:async_hooks";

/** A spent forge limit: when it resets (epoch milliseconds) and the refusal's own words. */
export interface ForgeLimit {
  until: number;
  reason: string;
}

let seen: ForgeLimit | null = null;

const fenced = new AsyncLocalStorage<{ limit: ForgeLimit | null }>();

/** Run a sequence of forge calls that must stop as soon as any of them meets the limit. */
export async function fenceOnForgeLimit<T>(
  work: () => Promise<T>,
): Promise<{ value: T; limit: ForgeLimit | null }> {
  const fence = { limit: forgeLimitHeld() };
  const value = await fenced.run(fence, work);
  return { value, limit: fence.limit };
}

/** Refuse subsequent calls in this operation, even if its last read outlasted the reset. */
export function fencedForgeLimit(): ForgeLimit | null {
  return fenced.getStore()?.limit ?? null;
}

/** Record what a forge call answered: `failure` as its run classified it, `null` for a success. */
export function noteForgeAnswer(failure: OutboundFailure | null): void {
  if (failure === null) {
    seen = null;
    return;
  }
  if (failure.code !== "rate-limited" || failure.until === undefined) return;
  const fence = fenced.getStore();
  if (fence !== undefined && fence.limit === null)
    fence.limit = { until: failure.until, reason: failure.reason };
  if (seen === null || failure.until >= seen.until)
    seen = { until: failure.until, reason: failure.reason };
}

/** The spent limit this process last met, while its reset is still ahead of `now`; `null` otherwise. */
export function forgeLimitHeld(now: number = currentMs()): ForgeLimit | null {
  return seen !== null && seen.until > now ? seen : null;
}

/** Forget what was met. For a test that runs several cases in one process. */
export function clearForgeLimit(): void {
  seen = null;
}
