/**
 * The model-provider variables a launch's environment removes, and the ones
 * a provider account's launch adds back.
 *
 * Every removal matches a name whatever its letter case: environment names
 * are case-insensitive on Windows, so `Anthropic_Api_Key` would otherwise
 * survive the copy and bill the key instead of the account. One function
 * serves both kinds of account.
 *
 * A subscription account's launch removes the vendors' credential variables
 * (`SUBSCRIPTION_CREDENTIALS`), each vendor's directory variable and the
 * harness markers. A provider account's launch starts from that same
 * environment and removes every provider key besides (`PROVIDER_KEYS`),
 * then adds its own credential under the variable its harness reads, its
 * base URL where it names one, and its identity
 * (`PROVIDER_IDENTITY_VARIABLE`), which the drive's identity resolver reads.
 */
import { SECRET_VARIABLES } from "../../shared/credentials.ts";
import {
  type AccountVendor,
  PROVIDER_IDENTITY_VARIABLE,
} from "../../skills/drive-pr/scripts/lib/identity.ts";

/** The credential variables the drive's resolver reads before a configuration directory. */
export const SUBSCRIPTION_CREDENTIALS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

/** The variable that names each vendor's configuration directory. */
export const DIRECTORY_VARIABLE: Record<AccountVendor, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/**
 * The variable the wrapper hands a resolved credential to its supervisor
 * in (`provider-launch.ts`); never part of a pass's environment.
 */
export const CREDENTIAL_HANDOFF = "JIG_PROVIDER_CREDENTIAL";

/**
 * Every model provider's key, token and endpoint variable a provider
 * account's launch removes before it adds its own: the vendors' credentials,
 * the keys of the providers a harness may reach, the endpoint variables that
 * would send a pass elsewhere, and the switches that move Claude Code to
 * another cloud's billing.
 */
export const PROVIDER_KEYS = [
  ...SUBSCRIPTION_CREDENTIALS,
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BASE_URL",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "AZURE_OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "OPENCODE_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  CREDENTIAL_HANDOFF,
  PROVIDER_IDENTITY_VARIABLE,
  SECRET_VARIABLES,
] as const;

/** The variables no pass carries on this host (`credential_env`), as the machine file read here names them. */
let withheld: readonly string[] = [];

/** Withhold `names` from every pass's environment this process builds from now on. */
export function withholdFromPasses(names: readonly string[]): void {
  withheld = [...new Set([...withheld, ...names])];
}

/** The variables no pass this process starts may carry (`withholdFromPasses`). */
export function withheldFromPasses(): readonly string[] {
  return withheld;
}

/** `env` without the variables `names` lists and those that start with one of `prefixes`, whatever their letter case. */
export function withoutVariables(
  env: Record<string, string>,
  names: readonly string[],
  prefixes: readonly string[] = [],
): Record<string, string> {
  const listed = new Set(names.map((name) => name.toUpperCase()));
  const starts = prefixes.map((prefix) => prefix.toUpperCase());
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (listed.has(upper) || starts.some((prefix) => upper.startsWith(prefix)))
      delete env[name];
  }
  return env;
}

/** The harnesses a provider account may run in: each vendor's own program. */
export const HARNESS_VENDOR = {
  "claude-code": "claude",
  codex: "codex",
} as const satisfies Record<string, AccountVendor>;
export type Harness = keyof typeof HARNESS_VENDOR;

/**
 * The variables a harness's program reads its provider credential and its
 * endpoint from. Claude Code reads Anthropic's names and Codex OpenAI's,
 * whichever provider the base URL reaches.
 */
const HARNESS_VARIABLES: Record<
  Harness,
  { credential: string; baseUrl: string }
> = {
  "claude-code": {
    credential: "ANTHROPIC_API_KEY",
    baseUrl: "ANTHROPIC_BASE_URL",
  },
  codex: { credential: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
};

/** What a provider account's launch adds to its environment, beside its configuration directory. */
export interface ProviderLaunch {
  harness: Harness;
  /** Where the harness sends its requests; `null` for the program's own default. */
  baseUrl: string | null;
  /** The derived identity (`provider:<provider>:<fingerprint>`). */
  identity: string;
}

/** What a provider account's launch record carries: its provider, beside what its environment adds. */
export interface ProviderRecord extends ProviderLaunch {
  provider: string;
}

/**
 * Remove every provider key from `env` and add the account's own: its
 * identity, its base URL where it names one, and its resolved credential
 * where one is given (`null` for a read that needs no secret, such as the
 * identity check).
 */
export function withProviderVariables(
  env: Record<string, string>,
  launch: ProviderLaunch,
  credential: string | null,
): Record<string, string> {
  withoutVariables(env, PROVIDER_KEYS);
  const names = HARNESS_VARIABLES[launch.harness];
  env[PROVIDER_IDENTITY_VARIABLE] = launch.identity;
  if (launch.baseUrl !== null) env[names.baseUrl] = launch.baseUrl;
  if (credential !== null) {
    env[names.credential] = credential;
    env[SECRET_VARIABLES] = names.credential;
  }
  return env;
}
