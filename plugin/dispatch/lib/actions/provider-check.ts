/**
 * What the tick checks of a provider account before it reserves a launch
 * on it: that its credential resolves now, so a refused or missing key
 * starts nothing (no workspace, no record, no slot), and the repository's
 * allow list it is checked against.
 *
 * The value is resolved and dropped here; the launch's wrapper resolves it
 * again for the pass (`provider-launch.ts`). A refusal is `unauthorized`:
 * the account is held with the reason and one host need stands for it
 * (`provider-credential.ts`), and admission moves on to the next account.
 * A command that does not answer is `unreachable`: the launch waits for the
 * next tick.
 */
import type { IdentityCheck } from "../accounts.ts";
import type { MachineAccount } from "../machine-config.ts";
import { credentialEnvOf } from "../credential-env.ts";
import type { AllowList } from "../provider-allow.ts";
import {
  credentialResolved,
  holdForCredential,
  resolveCredential,
} from "../provider-credential.ts";
import type { LaneWait } from "../types.ts";
import type { ApplyState } from "./launch.ts";

/**
 * The allow list a launch for `repo` is checked against: the one its
 * section named this tick. A tick that read the lists but none for `repo`
 * refuses every account for it; with no lists read at all, none applies
 * (the default).
 */
export function allowListOf(state: ApplyState, repo: string): AllowList {
  const lists = state.allowedProviders;
  if (lists === undefined) return { repo, providers: null };
  if (!lists.has(repo)) return { repo, providers: null, unread: true };
  return { repo, providers: lists.get(repo) ?? null };
}

/** An identity check's answer once a provider account's credential is checked too. */
export async function prelaunchCredential(
  state: ApplyState,
  account: MachineAccount,
  identity: IdentityCheck,
  hasTime: boolean,
): Promise<IdentityCheck | { waits: string; waitsOn: LaneWait }> {
  const provider = account.provider;
  if (provider === undefined || !identity.ok) return identity;
  if (!hasTime)
    return {
      waits:
        "the tick deadline has no room for the credential command and its receipt; a later tick retries this one",
      waitsOn: "tick-deadline",
    };
  const value = await resolveCredential(
    state.machine.credentials,
    provider.credential,
    credentialEnvOf(state.machine),
  );
  if (value.ok) {
    credentialResolved(account, state.root);
    return identity;
  }
  if (value.failure.code === "unreachable")
    return {
      waits: `unreachable: ${value.failure.reason}`,
      waitsOn: "accounts",
    };
  holdForCredential(
    account,
    value.failure.reason,
    state.machine.wallBackoffMs,
    state.root,
  );
  return { ok: false, reason: `unauthorized: ${value.failure.reason}` };
}
