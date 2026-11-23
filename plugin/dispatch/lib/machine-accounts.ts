/**
 * The machine file's `accounts`: what each entry bills, by its `kind`.
 *
 * - `subscription` (the default): a vendor's subscription, signed in inside
 *   `config_dir`, with the keys `name`, `kind`, `vendor`, `harness`,
 *   `config_dir`, `identity`, `max_per_account` and `stages`. Its `harness`,
 *   when named, is the vendor's own program (`claude-code` for `claude`,
 *   `codex` for `codex`): a Claude login never reaches another harness.
 * - `provider`: the host's own key with a model provider
 *   (`provider-account.ts`).
 *
 * Each name and each identity is listed once; a subscription's
 * `config_dir` once per vendor, and a provider account's once across every
 * account of both kinds.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { ok } from "../../shared/outcome.ts";
import { accountName, slotsAndStages } from "./account-fields.ts";
import type { MachineAccount } from "./machine-config.ts";
import {
  type Checked,
  distinct,
  each,
  invalid,
  list,
  only,
  path,
  text,
} from "./machine-values.ts";
import {
  type CredentialSettings,
  providerAccount,
} from "./provider-account.ts";
import { HARNESS_VENDOR } from "./provider-environment.ts";

const ACCOUNT_KEYS = [
  "name",
  "kind",
  "vendor",
  "harness",
  "config_dir",
  "identity",
  "max_per_account",
  "stages",
];

/** The harness each subscription vendor's own program is. */
const OWN_HARNESS: Record<string, string> = Object.fromEntries(
  Object.entries(HARNESS_VENDOR).map(([harness, vendor]) => [vendor, harness]),
);

/** A subscription's `harness`: absent, or its vendor's own program. */
function subscriptionHarness(
  value: unknown,
  vendor: string,
  where: string,
): Checked<true> {
  if (value === undefined || value === null) return ok(true);
  const own = OWN_HARNESS[vendor];
  if (value === own) return ok(true);
  return invalid(
    own === undefined
      ? `${where}.harness: the ${vendor} vendor has no registered harness`
      : `${where}.harness must be ${own}: a ${vendor} subscription runs only in its own program`,
  );
}

function subscription(
  value: Record<string, unknown>,
  where: string,
  maxPerAccount: number,
): Checked<MachineAccount> {
  const known = only(value, ACCOUNT_KEYS, where);
  if (!known.ok) return known;
  const vendor = subscriptionVendor(value, where);
  if (!vendor.ok) return vendor;
  const name = accountName(value.name, where);
  if (!name.ok) return name;
  const configDir = path(value.config_dir, `${where}.config_dir`);
  if (!configDir.ok) return configDir;
  const identity = text(value.identity, `${where}.identity`);
  if (!identity.ok) return identity;
  const served = slotsAndStages(value, where, name.value, maxPerAccount);
  if (!served.ok) return served;
  return ok({
    name: name.value,
    vendor: vendor.value,
    configDir: configDir.value,
    identity: identity.value,
    ...served.value,
  });
}

/** A subscription's `vendor`, and its `harness` checked against it. */
function subscriptionVendor(
  value: Record<string, unknown>,
  where: string,
): Checked<string> {
  const vendor = text(value.vendor, `${where}.vendor`);
  if (!vendor.ok) return vendor;
  if (!/^[a-z][a-z0-9-]*$/.test(vendor.value))
    return invalid(
      `${where}.vendor must be an agent tool's name in lowercase letters, digits and dashes (claude, codex): ${vendor.value}`,
    );
  const harness = subscriptionHarness(value.harness, vendor.value, where);
  return harness.ok ? vendor : harness;
}

function account(
  value: unknown,
  i: number,
  settings: CredentialSettings,
  maxPerAccount: number,
): Checked<MachineAccount> {
  const where = `accounts[${i}]`;
  if (!isMapping(value)) return invalid(`${where} must be a mapping`);
  const kind = value.kind ?? "subscription";
  if (kind === "provider")
    return providerAccount(value, where, settings, maxPerAccount);
  if (kind !== "subscription")
    return invalid(`${where}.kind must be subscription or provider`);
  return subscription(value, where, maxPerAccount);
}

/** The accounts, each name, identity and configuration directory listed once. */
export function machineAccounts(
  value: unknown,
  settings: CredentialSettings,
  maxPerAccount: number,
): Checked<MachineAccount[]> {
  const raw = list(value, "accounts");
  if (!raw.ok) return raw;
  const read = each(raw.value, (entry, i) =>
    account(entry, i, settings, maxPerAccount),
  );
  if (!read.ok) return read;
  const named = distinct(read.value, (a) => a.name, "an account");
  if (!named.ok) return named;
  const identities = distinct(
    named.value,
    (a) => `${a.vendor}:${a.identity.toLowerCase()}`,
    "an account identity",
  );
  if (!identities.ok) return identities;
  const directories = distinct(
    identities.value,
    (a) => `${a.vendor}:${a.configDir}`,
    "an account configuration directory",
  );
  if (!directories.ok) return directories;
  const shared = directories.value.find(
    (a) =>
      a.provider !== undefined &&
      directories.value.some((b) => b !== a && b.configDir === a.configDir),
  );
  return shared === undefined
    ? directories
    : invalid(
        `an account configuration directory listed twice: ${shared.configDir} (a provider account's directory is its own)`,
      );
}
