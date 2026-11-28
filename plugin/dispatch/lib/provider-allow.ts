/**
 * A repository's provider allow list (`dispatch.allowed_providers`): the
 * model providers its code and tracker text may be sent to.
 *
 * The list is read with the rest of the repository's `dispatch` section,
 * from its configuration file as the default branch holds it on the forge
 * (`section.ts`), never from a checkout, a pull request's branch, the user
 * file or the environment: an unreviewed branch cannot widen it, and the
 * machine file chooses which accounts exist but cannot add a provider the
 * list lacks.
 *
 * A subscription account counts under its vendor's provider (`anthropic`
 * for Claude Code's, `openai` for Codex's); a provider account under its
 * `provider`. A repository with no list is admitted on its Claude and
 * OpenAI subscription accounts only: a provider account needs the list to
 * name its provider, even `anthropic` or `openai`. A list that leaves out
 * `anthropic` therefore keeps the repository off its Claude subscription
 * accounts too.
 *
 * Every launch that sends the repository's text to a provider (a pickup, a
 * re-arm or takeover, a follow-up, a steward pass) is checked before
 * anything is reserved; a refusal says `provider-not-allowed` and names
 * the repository, the account and the provider.
 */
import { ok } from "../../shared/outcome.ts";
import type { MachineAccount } from "./machine-config.ts";
import { type Checked, invalid } from "./machine-values.ts";
import { PROVIDER_NAME } from "./provider-account.ts";

/** The provider each subscription vendor's account sends a pass's text to. */
const VENDOR_PROVIDER: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
};

/** What a repository with no list admits: its subscription accounts of these providers. */
const DEFAULT_ALLOWED_PROVIDERS = ["anthropic", "openai"] as const;

/** The refusal's reason code, which receipts and the dashboard line show. */
export const PROVIDER_NOT_ALLOWED = "provider-not-allowed";

/** One repository's allow list, as a launch for it is checked against it. */
export interface AllowList {
  /** The repository's `owner/name`. */
  repo: string;
  /** Its `dispatch.allowed_providers`; `null` when it has none. */
  providers: readonly string[] | null;
  /** The tick read the repositories' lists and none for this one: every account is refused. */
  unread?: true;
}

/** The provider an account sends a pass's text to; `null` for a vendor no provider is known for. */
function providerOf(
  account: Pick<MachineAccount, "vendor" | "provider">,
): string | null {
  return account.provider?.provider ?? VENDOR_PROVIDER[account.vendor] ?? null;
}

/**
 * Why a launch for `allow.repo` may not run on `account`; `null` when the
 * repository's list (or, with none, the default) admits it.
 */
export function providerRefusal(
  account: Pick<MachineAccount, "name" | "vendor" | "provider">,
  allow: AllowList,
): string | null {
  const provider = providerOf(account);
  if (allow.unread === true)
    return `${PROVIDER_NOT_ALLOWED}: ${allow.repo}'s provider allow list was not read this tick, so no account is allowed for it`;
  const listed =
    allow.providers === null
      ? account.provider === undefined &&
        provider !== null &&
        (DEFAULT_ALLOWED_PROVIDERS as readonly string[]).includes(provider)
      : provider !== null && allow.providers.includes(provider);
  if (listed) return null;
  const why =
    allow.providers === null
      ? account.provider === undefined
        ? "its dispatch section names no allowed_providers, which admits only Claude and OpenAI subscription accounts"
        : "its dispatch section names no allowed_providers, and a provider account needs the list to name its provider"
      : `its dispatch.allowed_providers is [${allow.providers.join(", ")}]`;
  return `${PROVIDER_NOT_ALLOWED}: ${allow.repo} does not allow the provider ${provider ?? `of the vendor ${account.vendor}`} of the account ${account.name}; ${why}`;
}

/** `dispatch.allowed_providers`: absent, or a list of distinct provider names. */
export function allowedProviders(value: unknown): Checked<string[] | null> {
  if (value === undefined || value === null) return ok(null);
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || !PROVIDER_NAME.test(name))
  )
    return invalid(
      "dispatch.allowed_providers must list provider names in lowercase letters, digits and dashes (anthropic, openai, openrouter)",
    );
  if (new Set(value).size !== value.length)
    return invalid("dispatch.allowed_providers lists a provider twice");
  return ok([...(value as string[])]);
}
