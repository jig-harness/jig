/**
 * The identity check before a launch: the drive's own resolver on the
 * account's environment, then, for a Claude subscription, its sign-in, and
 * for a provider account, its credential (`provider-check.ts`).
 */
import { SIGN_IN_TIMEOUT_SEC } from "../claude-sign-in.ts";
import { checkIdentity, type IdentityCheck, type Slots } from "../accounts.ts";
import type { LaneWait } from "../types.ts";
import { prelaunchSignIn } from "./account-sign-in.ts";
import { settleMs, timeLeftMs } from "./launch-deadline.ts";
import type { ApplyState } from "./launch.ts";
import { prelaunchCredential } from "./provider-check.ts";

/** An identity check's answer, or that the tick has no time for one: a deferral, not a verdict on the account. */
export type IdentityAnswer =
  | IdentityCheck
  | { waits: string; waitsOn: LaneWait };

export async function identityOf(
  state: ApplyState,
  slots: Slots,
): Promise<IdentityAnswer> {
  // Every identity check, including the one after an open, must leave the receipt's reserve intact,
  // and a resolver that must be killed takes its grace beyond the timeout.
  const timeoutSec = Math.ceil(state.machine.runtimeTimeoutMs / 1000);
  const left = timeLeftMs(state);
  if (left !== null && left < settleMs(state.machine.runtimeTimeoutMs))
    return {
      waits:
        "the tick deadline has no room for the identity check and its receipt; a later tick retries this one",
      waitsOn: "tick-deadline",
    };
  // Read afresh each time: a login file can change between two launches.
  const settings =
    state.runtime.name === "process"
      ? (state.machine.process ?? { envKeep: [] })
      : undefined;
  const identity = await checkIdentity(slots.account, timeoutSec, settings);
  const remaining = timeLeftMs(state);
  if (slots.account.provider !== undefined)
    return prelaunchCredential(
      state,
      slots.account,
      identity,
      remaining === null ||
        remaining >=
          settleMs(state.machine.credentials?.credentialTimeoutMs ?? 0),
    );
  if (!identity.ok || slots.account.vendor !== "claude") return identity;
  return prelaunchSignIn(
    state,
    slots.account,
    identity,
    settings,
    remaining === null || remaining >= settleMs(SIGN_IN_TIMEOUT_SEC * 1000),
  );
}
