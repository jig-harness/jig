/** A provider account's identity: derived, resolved by the drive's own resolver with no secret, and hashed for the drive's records. */
import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountHash,
  isAccountHash,
} from "../../skills/drive-pr/scripts/lib/identity.ts";
import { checkIdentity } from "../lib/accounts.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import { providerIdentity } from "../lib/provider-account.ts";

function router(identity?: string): MachineAccount {
  const credential = "op://Jig/router/credential";
  return {
    name: "router",
    vendor: "claude",
    configDir: mkdtempSync(join(tmpdir(), "provider-identity-")),
    identity: identity ?? providerIdentity("openrouter", credential, null),
    maxPerAccount: 2,
    provider: {
      harness: "claude-code",
      provider: "openrouter",
      baseUrl: null,
      credential,
      billing: "pay-per-token",
      spendCap: { daily: "20.00", perRun: null, timezone: "UTC" },
      models: null,
    },
  };
}

it("resolves, with the drive's resolver and no login, to the identity the machine file derives", async () => {
  const account = router();
  expect(await checkIdentity(account, 30)).toEqual({ ok: true });
  // The same directory as a subscription account's has no login to resolve.
  const { provider: _provider, ...subscription } = account;
  expect(
    await checkIdentity({ ...subscription, identity: "me@example.com" }, 30),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("no oauthAccount"),
  });
});

it("hashes a provider account's identity for the drive's records, never a key's fingerprint", () => {
  const identity = providerIdentity("openrouter", "op://Jig/r/c", null);
  const hash = accountHash({
    account: identity,
    vendor: "claude",
    provenance: "JIG_PROVIDER_IDENTITY",
    reason: null,
  });
  expect(isAccountHash(hash)).toBe(true);
  expect(
    accountHash({
      account: "api-key:0123456789ab",
      vendor: "codex",
      provenance: "OPENAI_API_KEY",
      reason: null,
    }),
  ).toBeNull();
});
