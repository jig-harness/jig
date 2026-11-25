/**
 * The parts of an account identity every harness's reader shares: the
 * resolved and unresolved forms, and a credential's fingerprint.
 *
 * Every reader either reads a real, on-disk identity record or a credential
 * in its own environment, or returns `null` with a stated reason: none
 * invents an account from an unrelated signal.
 */
import { createHash } from "node:crypto";
import type { AccountIdentity, HarnessName } from "./port.ts";

export function resolved(
  vendor: HarnessName,
  account: string,
  provenance: string,
): AccountIdentity {
  return { account, vendor, provenance, reason: null };
}

export function unresolved(
  vendor: HarnessName | null,
  provenance: string,
  reason: string,
): AccountIdentity {
  return { account: null, vendor, provenance, reason };
}

/**
 * The first 12 hex characters of the credential's sha256: enough to tell two
 * credentials (and so two accounts) apart in a listing, never enough to
 * recover it. A display label, not an authorization decision.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
