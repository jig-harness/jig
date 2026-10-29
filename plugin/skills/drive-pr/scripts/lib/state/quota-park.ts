/**
 * `drive-state.ts quota-park`: record the quota wall a drive parked on, and
 * the hashed account it belongs to, without stamping progress (parking is
 * progress's opposite; the next genuine progress event clears it).
 */
import { fail, sleep, testDelaySeconds } from "../cli.ts";
import { isAccountHash } from "../identity.ts";
import type { StateStore } from "./store.ts";

export interface QuotaParkArgs {
  vendor: string;
  window: string;
  /** `''` when the reset is unknown. */
  resetAt: string;
  /** `''` when the account is unknown. */
  account: string;
}

export async function quotaPark(
  store: StateStore,
  a: QuotaParkArgs,
): Promise<number> {
  if (a.vendor === "") fail(2, "quota-park requires --vendor V");
  if (/[\n\r]/.test(a.vendor)) {
    fail(2, "quota-park: --vendor must not contain a newline");
  }
  if (a.window === "") fail(2, "quota-park requires --window W");
  if (/[\n\r]/.test(a.window)) {
    fail(2, "quota-park: --window must not contain a newline");
  }
  if (a.account !== "" && !isAccountHash(a.account))
    fail(
      2,
      `quota-park: --account must be an account hash (got '${a.account}')`,
    );
  if (a.resetAt !== "" && !Number.isFinite(Date.parse(a.resetAt))) {
    fail(
      2,
      `quota-park: --reset-at must be a string Date.parse can read (got '${a.resetAt}')`,
    );
  }
  // Test-only hook, unset (no-op) by default: forces a lock takeover to
  // land while `drive.ts`'s `recordQuotaPark` awaits this subprocess.
  const delaySec = testDelaySeconds(
    "DRIVE_PR_QUOTA_PARK_TEST_DELAY",
    "quota-park",
  );
  if (delaySec > 0) await sleep(delaySec);
  await store.update((s) => ({
    ...s,
    quotaPark: {
      vendor: a.vendor,
      window: a.window,
      resetAt: a.resetAt === "" ? null : a.resetAt,
      at: new Date().toISOString(),
      ...(a.account === "" ? {} : { account: a.account }),
    },
  }));
  return 0;
}
