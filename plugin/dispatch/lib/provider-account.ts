/**
 * A provider account in the machine file: an entry of `kind: provider`, which
 * bills a model provider with the host's own key rather than a vendor's
 * subscription (design/provider-accounts.md).
 *
 * ```yaml
 * credential_command: [op, read, --no-newline]   # the reference is appended as one last argument
 * credential_timeout: 10s
 * credential_env: [OP_SERVICE_ACCOUNT_TOKEN]     # the host's variables the command needs; no pass carries them
 * provider_hosts:                                # hosts a base URL may name beyond the provider's own
 *   openrouter: [llm-proxy.internal.example]
 * accounts:
 *   - name: router
 *     kind: provider
 *     harness: claude-code                       # or codex
 *     provider: openrouter
 *     base_url: https://openrouter.ai/api
 *     credential: op://Jig/router/credential     # a reference, never the key
 *     billing: pay-per-token                     # or flat-rate, which has no spend_cap
 *     spend_cap: {daily: "20.00", per_run: "2.50", timezone: Europe/Amsterdam}
 *     models: [{id: some-model, price: {input: "3.00", output: "15.00"}}]
 *     stages: [rearm]
 * ```
 *
 * The entry has no `vendor` and no `identity`: its harness names the program
 * (and so the vendor type the launch code uses), and its identity is
 * derived, `provider:<provider>:<fingerprint>`, the fingerprint being the
 * first 12 hexadecimal characters of the SHA-256 of the credential reference
 * and the base URL (empty when the entry names none) joined by a newline.
 *
 * A credential is a reference: a scheme, `://` and a path with no
 * whitespace (`op://Vault/item/field`), which nothing in it may make look
 * like a credential to `shared/credentials.ts`. Anything else is refused
 * with its value withheld, so a key pasted where the reference belongs
 * never reaches a reason, a receipt or a log.
 *
 * `billing: pay-per-token` (the default) requires `spend_cap.daily`; a
 * `flat-rate` plan has no spend cap, since its own usage windows bound it
 * through the account's wall and `max_per_account`, as a subscription's do.
 *
 * Until the spend cap (for a metered account), the endpoint routing, the
 * redaction and the original-transcript handling are in place, a provider
 * account is parsed and reported and never admitted:
 * `PROVIDER_ADMISSION_HOLD`.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { maskCredentialShapes } from "../../shared/credentials.ts";
import { ok } from "../../shared/outcome.ts";
import { isTimeZone } from "../../shared/time.ts";
import { accountName, slotsAndStages } from "./account-fields.ts";
import { credentialEnvNames } from "./credential-env.ts";
import { duration } from "./duration.ts";
import type { MachineAccount } from "./machine-config.ts";
import {
  type Checked,
  each,
  invalid,
  list,
  only,
  path,
  text,
} from "./machine-values.ts";
import { type Harness, HARNESS_VENDOR } from "./provider-environment.ts";

/**
 * Why a provider account is not admitted until the spend cap (for a metered
 * account), the endpoint routing, the redaction and the original-transcript
 * work have landed. Lifting it removes the hold for flat-rate accounts too,
 * so `null` waits for all of that work;
 * `null` lifts the hold. The one place that work changes.
 */
export const PROVIDER_ADMISSION_HOLD: string | null =
  "a provider account is not launched on until its endpoint routing, redaction and original-transcript handling (and, for a pay-per-token account, its spend cap) are in place";

/** Why `account` is held back from every launch; `null` when it is not. */
export function providerHold(
  account: Pick<MachineAccount, "provider">,
): string | null {
  return account.provider === undefined || PROVIDER_ADMISSION_HOLD === null
    ? null
    : `configured, not admitted: ${PROVIDER_ADMISSION_HOLD}`;
}

/** How a provider account is billed. */
export type Billing = "pay-per-token" | "flat-rate";

/** One model an account may run, with what it costs where the provider reports no cost. */
export interface ProviderModel {
  id: string;
  /** Decimal US dollars per million tokens. */
  price?: { input: string; output: string };
}

/** The machine-file fields of a provider account (`kind: provider`). */
export interface ProviderAccount {
  harness: Harness;
  /** The provider it bills, as a repository's allow list spells it. */
  provider: string;
  /** Where the harness sends its requests; `null` for the program's own default. */
  baseUrl: string | null;
  /** The credential reference, never the credential. */
  credential: string;
  billing: Billing;
  /** Decimal US dollars as strings; `null` for a flat-rate plan. */
  spendCap: { daily: string; perRun: string | null; timezone: string } | null;
  /** The models it may run; `null` for any model the harness accepts. */
  models: ProviderModel[] | null;
}

/** The machine file's settings every provider account reads. */
export interface CredentialSettings {
  /** The argument list that prints a credential for a reference appended as its last argument; `null` when the file names none. */
  credentialCommand: string[] | null;
  credentialTimeoutMs: number;
  /** The host's variables the command runs with beside its base (`credential_env`), which no pass carries. */
  credentialEnv: string[];
  /** Hosts a base URL may name for each provider beyond the provider's own, lower-cased. */
  providerHosts: Record<string, string[]>;
}

const DEFAULT_CREDENTIAL_TIMEOUT_MS = 10_000;

/** A provider's name, and a repository allow list's entry. */
export const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;

/** The hosts each provider's own API answers on; a base URL elsewhere needs `provider_hosts`. */
const PROVIDER_PROFILE_HOSTS: Record<string, readonly string[]> = {
  anthropic: ["api.anthropic.com"],
  openai: ["api.openai.com"],
  openrouter: ["openrouter.ai"],
  gemini: ["generativelanguage.googleapis.com"],
};

/** The provider each harness program reaches when no endpoint is set. */
const DEFAULT_ENDPOINT_PROVIDER: Record<Harness, string> = {
  "claude-code": "anthropic",
  codex: "openai",
};

/** Whether `value` holds a backslash, a space or a control character: what a plain URL never carries. */
function hasRefusedCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || character === "\\") return true;
  }
  return false;
}

/** The list `table` holds for `key` itself, never one an object inherits (`constructor`). */
function ownEntry(
  table: Record<string, readonly string[]>,
  key: string,
): readonly string[] {
  return Object.hasOwn(table, key) ? (table[key] ?? []) : [];
}

const PROVIDER_KEYS = [
  "name",
  "kind",
  "harness",
  "provider",
  "base_url",
  "credential",
  "billing",
  "spend_cap",
  "models",
  "config_dir",
  "max_per_account",
  "stages",
];
const SPEND_CAP_KEYS = ["daily", "per_run", "timezone"];

/** A credential reference: a scheme, `://` and a path without whitespace. */
const REFERENCE = /^[a-z][a-z0-9+.-]*:\/\/[^\s\0]+$/;
const LONGEST_REFERENCE = 1024;

/** A provider account's identity, from its reference and base URL. */
export function providerIdentity(
  provider: string,
  reference: string,
  baseUrl: string | null,
): string {
  const digest = createHash("sha256")
    .update(`${reference}\n${baseUrl ?? ""}`)
    .digest("hex");
  return `provider:${provider}:${digest.slice(0, 12)}`;
}

/** Whether `reference` is a credential reference and nothing in it reads as a credential. */
function isCredentialReference(reference: string): boolean {
  return (
    reference.length <= LONGEST_REFERENCE &&
    REFERENCE.test(reference) &&
    maskCredentialShapes(reference, "\u0000") === reference
  );
}

/** The `credential_command`, `credential_timeout`, `credential_env` and `provider_hosts` settings. */
export function credentialSettings(
  top: Record<string, unknown>,
): Checked<CredentialSettings> {
  const raw = top.credential_command;
  let credentialCommand: string[] | null = null;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw) || raw.length === 0)
      return invalid(
        "credential_command must be a nonempty list of arguments, run without a shell",
      );
    const words = each(raw, (word, i) =>
      typeof word === "string" && word !== "" && !/[\0\r\n]/.test(word)
        ? ok(word)
        : invalid(`credential_command[${i}] must be a nonempty string`),
    );
    if (!words.ok) return words;
    credentialCommand = words.value;
  }
  const timeout =
    top.credential_timeout === undefined || top.credential_timeout === null
      ? ok(DEFAULT_CREDENTIAL_TIMEOUT_MS)
      : duration(top.credential_timeout, "credential_timeout");
  if (!timeout.ok) return timeout;
  if (timeout.value <= 0)
    return invalid("credential_timeout must be longer than 0s");
  const hosts = providerHosts(top.provider_hosts);
  if (!hosts.ok) return hosts;
  const env = credentialEnvNames(
    top.credential_env,
    isMapping(top.process) ? top.process.env_keep : undefined,
  );
  if (!env.ok) return env;
  return ok({
    credentialCommand,
    credentialTimeoutMs: timeout.value,
    credentialEnv: env.value,
    providerHosts: hosts.value,
  });
}

function providerHosts(value: unknown): Checked<Record<string, string[]>> {
  if (value === undefined || value === null) return ok({});
  if (!isMapping(value)) return invalid("provider_hosts must be a mapping");
  const out: Record<string, string[]> = {};
  for (const [provider, hosts] of Object.entries(value)) {
    const where = `provider_hosts.${provider}`;
    if (!PROVIDER_NAME.test(provider))
      return invalid(
        `${where} must name a provider in lowercase letters, digits and dashes`,
      );
    if (!Array.isArray(hosts)) return invalid(`${where} must list host names`);
    const names = each(hosts, (host, i) => {
      const bad = invalid(
        `${where}[${i}] must be a bare host name, with no scheme, port or path`,
      );
      if (typeof host !== "string" || !/^[A-Za-z0-9.:[\]-]+$/.test(host))
        return bad;
      // The same canonical form the URL check compares against (`URL.hostname`): a port, or a spelling the URL parser rewrites, is refused rather than silently never matching.
      if (!URL.canParse(`https://${host}`)) return bad;
      const parsed = new URL(`https://${host}`);
      return parsed.port === "" && parsed.hostname === host.toLowerCase()
        ? ok(parsed.hostname)
        : bad;
    });
    if (!names.ok) return names;
    out[provider] = names.value;
  }
  return ok(out);
}

/** A loopback host: the only one a plain `http:` base URL may name. */
function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** Why a parsed base URL's form is refused: credentials, a query, or a scheme other than `https:` (`http:` only on loopback); `null` when it is not. */
function urlFormRefusal(url: URL, where: string): string | null {
  if (url.username !== "" || url.password !== "")
    return `${where} must carry no user name or password (its value is withheld)`;
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(url.href))
    return `${where} must carry no query or fragment (its value is withheld)`;
  // One accepted path form: a percent escape is refused outright, so nothing can decode (once or nested) into a credential shape the check below never saw.
  if (url.pathname.includes("%"))
    return `${where} must carry a path with no percent escapes (its value is withheld)`;
  if (maskCredentialShapes(url.pathname, "\u0000") !== url.pathname)
    return `${where} must carry no credential-shaped value in its path (its value is withheld)`;
  const loopbackHttp =
    url.protocol === "http:" && isLoopbackHost(url.hostname.toLowerCase());
  return url.protocol === "https:" || loopbackHttp
    ? null
    : `${where} must be an https:// URL (plain http:// only on a loopback address)`;
}

/**
 * The base URL, canonical, or why it is refused: `https:` (or `http:` on a
 * loopback host), with no user name, password, query or fragment, on a host
 * the provider's own API answers on or `provider_hosts` names for it. A
 * loopback or private-network host is never a provider's own, so it needs
 * `provider_hosts` too.
 */
function baseUrl(
  value: unknown,
  where: string,
  provider: string,
  settings: CredentialSettings,
  harness: Harness,
): Checked<string | null> {
  if (value === undefined || value === null) {
    // An omitted endpoint is the harness program's own default, which only a known pairing verifies.
    return DEFAULT_ENDPOINT_PROVIDER[harness] === provider
      ? ok(null)
      : invalid(
          `${where} is required for ${provider} on ${harness}: only ${DEFAULT_ENDPOINT_PROVIDER[harness]} is that harness's own default endpoint`,
        );
  }
  // The value as written is checked before `text` trims it: a leading or trailing space or control character is refused like one inside.
  if (typeof value === "string" && hasRefusedCharacter(value))
    return invalid(
      `${where} must be a plain URL with no backslash, space or control character (its value is withheld)`,
    );
  if (typeof value === "string" && value !== value.trim())
    return invalid(
      `${where} must be a plain URL with no leading or trailing space (its value is withheld)`,
    );
  const raw = text(value, where);
  if (!raw.ok) return raw;
  if (!URL.canParse(raw.value))
    return invalid(`${where} must be an absolute URL`);
  const url = new URL(raw.value);
  // The path as written is checked before the URL parser normalizes it: a dot segment or an escaped dot could otherwise remove text the checks below never see.
  // Only a plain form is accepted: the URL parser also reads a backslash as a separator and drops tabs and line breaks, which would hide a path segment from these checks.
  const written = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*(\/[^?#\\]*)?$/i.exec(
    raw.value.split(/[?#]/)[0] ?? "",
  );
  if (written === null)
    return invalid(
      `${where} must be a plain URL with no backslash, space or control character (its value is withheld)`,
    );
  const writtenPath = written[1] ?? "";
  if (
    /%/.test(writtenPath) ||
    writtenPath.split("/").some((part) => part === "." || part === "..")
  )
    return invalid(
      `${where} must carry a path with no percent escapes or dot segments (its value is withheld)`,
    );
  const writtenShape = maskCredentialShapes(writtenPath, "\u0000");
  if (writtenShape !== writtenPath)
    return invalid(
      `${where} must carry no credential-shaped value in its path (its value is withheld)`,
    );
  const refused = urlFormRefusal(url, where);
  if (refused !== null) return invalid(refused);
  const host = url.hostname.toLowerCase();
  const allowed = [
    ...ownEntry(PROVIDER_PROFILE_HOSTS, provider),
    ...ownEntry(settings.providerHosts, provider),
  ];
  if (!allowed.includes(host))
    return invalid(
      `${where} names the host ${host}, which is not ${provider}'s own API; name it under provider_hosts.${provider} to allow it`,
    );
  // Only the root path's slash is dropped (`https://host/` is `https://host`); any other path is kept as written, since a server may tell `/api` from `/api/`.
  return ok(url.pathname === "/" ? url.origin : url.href);
}

/** Decimal US dollars written as a string; `positive` refuses zero. */
function dollars(
  value: unknown,
  where: string,
  positive: boolean,
): Checked<string> {
  if (typeof value === "number")
    return invalid(`${where} must be written as a quoted string ("20.00")`);
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(value.trim()))
    return invalid(`${where} must be decimal US dollars, such as "20.00"`);
  const amount = value.trim();
  if (positive && !/[1-9]/.test(amount))
    return invalid(`${where} must be more than 0`);
  return ok(amount);
}

/** `value`, absent read as `fallback`, else what `read` makes of it. */
function optional<T>(
  value: unknown,
  fallback: T,
  read: (present: unknown) => Checked<T>,
): Checked<T> {
  return value === undefined || value === null ? ok(fallback) : read(value);
}

/** The cap's day's time zone: `UTC` when absent. */
function capZone(value: unknown, where: string): Checked<string> {
  const zone = optional(value, "UTC", (v) => text(v, where));
  if (!zone.ok) return zone;
  return isTimeZone(zone.value)
    ? zone
    : invalid(
        `${where} must be a time zone name such as Europe/Amsterdam: ${zone.value}`,
      );
}

/** A pay-per-token account's `spend_cap`: a positive `daily`, an optional positive `per_run`, a time zone. */
function payPerTokenCap(
  value: unknown,
  where: string,
): Checked<NonNullable<ProviderAccount["spendCap"]>> {
  if (!isMapping(value) || value.daily === undefined || value.daily === null)
    return invalid(
      `${where}.spend_cap.daily is required for a pay-per-token account (billing: flat-rate for a plan bounded by its own usage windows)`,
    );
  const known = only(value, SPEND_CAP_KEYS, `${where}.spend_cap`);
  if (!known.ok) return known;
  const daily = dollars(value.daily, `${where}.spend_cap.daily`, true);
  if (!daily.ok) return daily;
  const perRun = optional<string | null>(value.per_run, null, (v) =>
    dollars(v, `${where}.spend_cap.per_run`, true),
  );
  if (!perRun.ok) return perRun;
  const zone = capZone(value.timezone, `${where}.spend_cap.timezone`);
  if (!zone.ok) return zone;
  return ok({ daily: daily.value, perRun: perRun.value, timezone: zone.value });
}

function spendCap(
  value: unknown,
  where: string,
  billing: Billing,
): Checked<ProviderAccount["spendCap"]> {
  if (billing === "pay-per-token") return payPerTokenCap(value, where);
  return value === undefined || value === null
    ? ok(null)
    : invalid(
        `${where}.spend_cap is for a pay-per-token key; a flat-rate plan is bounded by its own usage windows`,
      );
}

/** A model's `price`: what its input and output cost in US dollars per million tokens. */
function price(value: unknown, at: string): Checked<ProviderModel["price"]> {
  if (!isMapping(value)) return invalid(`${at} must be a mapping`);
  const known = only(value, ["input", "output"], at);
  if (!known.ok) return known;
  const input = dollars(value.input, `${at}.input`, false);
  if (!input.ok) return input;
  const output = dollars(value.output, `${at}.output`, false);
  if (!output.ok) return output;
  return ok({ input: input.value, output: output.value });
}

/** One entry of `models`: its `id`, and its `price` where given. */
function model(entry: unknown, at: string): Checked<ProviderModel> {
  if (!isMapping(entry)) return invalid(`${at} must be a mapping`);
  const known = only(entry, ["id", "price"], at);
  if (!known.ok) return known;
  const id = text(entry.id, `${at}.id`);
  if (!id.ok) return id;
  const cost = optional<ProviderModel["price"]>(entry.price, undefined, (v) =>
    price(v, `${at}.price`),
  );
  if (!cost.ok) return cost;
  return ok(
    cost.value === undefined
      ? { id: id.value }
      : { id: id.value, price: cost.value },
  );
}

function models(
  value: unknown,
  where: string,
): Checked<ProviderModel[] | null> {
  if (value === undefined || value === null) return ok(null);
  const raw = list(value, `${where}.models`);
  if (!raw.ok) return raw;
  return each(raw.value, (entry, i) => model(entry, `${where}.models[${i}]`));
}

function harness(value: unknown, where: string): Checked<Harness> {
  const raw = text(value, `${where}.harness`);
  if (!raw.ok) return raw;
  return Object.hasOwn(HARNESS_VENDOR, raw.value)
    ? ok(raw.value as Harness)
    : invalid(
        `${where}.harness must be a registered harness (${Object.keys(HARNESS_VENDOR).join(", ")}): ${raw.value}`,
      );
}

function billing(value: unknown, where: string): Checked<Billing> {
  if (value === undefined || value === null) return ok("pay-per-token");
  return value === "pay-per-token" || value === "flat-rate"
    ? ok(value)
    : invalid(`${where}.billing must be pay-per-token or flat-rate`);
}

function credential(value: unknown, where: string): Checked<string> {
  const refused = invalid(
    `${where}.credential must be a credential reference such as op://vault/item/field, never the credential itself (its value is withheld)`,
  );
  if (typeof value !== "string") return refused;
  const reference = value.trim();
  return isCredentialReference(reference) ? ok(reference) : refused;
}

/** The provider fields of an entry, before the account's name and slots. */
function providerFields(
  value: Record<string, unknown>,
  where: string,
  settings: CredentialSettings,
): Checked<ProviderAccount> {
  const program = harness(value.harness, where);
  if (!program.ok) return program;
  const provider = text(value.provider, `${where}.provider`);
  if (!provider.ok) return provider;
  if (!PROVIDER_NAME.test(provider.value))
    return invalid(
      `${where}.provider must be a provider's name in lowercase letters, digits and dashes: ${provider.value}`,
    );
  const url = baseUrl(
    value.base_url,
    `${where}.base_url`,
    provider.value,
    settings,
    program.value,
  );
  if (!url.ok) return url;
  const reference = credential(value.credential, where);
  if (!reference.ok) return reference;
  const billed = billing(value.billing, where);
  if (!billed.ok) return billed;
  const cap = spendCap(value.spend_cap, where, billed.value);
  if (!cap.ok) return cap;
  const allowed = models(value.models, where);
  if (!allowed.ok) return allowed;
  return ok({
    harness: program.value,
    provider: provider.value,
    baseUrl: url.value,
    credential: reference.value,
    billing: billed.value,
    spendCap: cap.value,
    models: allowed.value,
  });
}

/** The default configuration directory of a provider account: its own, never the host's harness directory. */
function harnessDirectory(name: string): string {
  return join(homedir(), ".local", "state", "jig", "harness", name);
}

/** A `kind: provider` entry, `where` naming it in every reason. */
export function providerAccount(
  value: Record<string, unknown>,
  where: string,
  settings: CredentialSettings,
  maxPerAccount: number,
): Checked<MachineAccount> {
  const known = only(value, PROVIDER_KEYS, where);
  if (!known.ok) return known;
  const name = accountName(value.name, where);
  if (!name.ok) return name;
  if (settings.credentialCommand === null)
    return invalid(
      `${where} (${name.value}) is a provider account and the machine file names no credential_command to resolve its credential`,
    );
  const fields = providerFields(value, `${where} (${name.value})`, settings);
  if (!fields.ok) return fields;
  const configDir =
    value.config_dir === undefined || value.config_dir === null
      ? ok(harnessDirectory(name.value))
      : path(value.config_dir, `${where}.config_dir`);
  if (!configDir.ok) return configDir;
  const served = slotsAndStages(value, where, name.value, maxPerAccount);
  if (!served.ok) return served;
  const provider = fields.value;
  return ok({
    name: name.value,
    vendor: HARNESS_VENDOR[provider.harness],
    configDir: configDir.value,
    identity: providerIdentity(
      provider.provider,
      provider.credential,
      provider.baseUrl,
    ),
    ...served.value,
    provider,
  });
}
