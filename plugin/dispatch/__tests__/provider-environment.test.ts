/** A launch's environment for each kind of account, side by side. */
import { describe, expect, it } from "bun:test";
import {
  passEnvironment,
  providerLaunchOf,
  providerPassEnvironment,
} from "../lib/accounts.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import { providerIdentity } from "../lib/provider-account.ts";
import { PROVIDER_KEYS } from "../lib/provider-environment.ts";
import { processEnvironment } from "../lib/runtime/process-environment.ts";

/** The host's environment as a tick sees it: its own settings, and every provider's key. */
const HOST = {
  HOME: "/home/me",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  GH_TOKEN: "forge-fixture",
  LINEAR_API_KEY: "tracker-fixture",
  CLAUDE_CODE_OAUTH_TOKEN: "host-oauth",
  ANTHROPIC_API_KEY: "host-anthropic",
  OPENAI_API_KEY: "host-openai",
  ANTHROPIC_AUTH_TOKEN: "host-auth-token",
  ANTHROPIC_BASE_URL: "https://elsewhere.example.test",
  OPENROUTER_API_KEY: "host-openrouter",
  GEMINI_API_KEY: "host-gemini",
  GOOGLE_API_KEY: "host-google",
  CODEX_API_KEY: "host-codex",
  CLAUDE_CONFIG_DIR: "/home/me/.claude",
  CODEX_HOME: "/home/me/.codex",
  CLAUDECODE: "1",
  CODEX_SANDBOX: "seatbelt",
};

/** The subscription account's environment as the dispatcher built it before provider accounts. */
function previousPassEnvironment(
  base: Record<string, string | undefined>,
  account: { vendor: "claude" | "codex"; configDir: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined) env[key] = value;
  for (const name of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ])
    delete env[name];
  for (const name of Object.keys(env))
    if (name === "CLAUDECODE" || name.startsWith("CODEX_")) delete env[name];
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete env[name];
  env[account.vendor === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] =
    account.configDir;
  return env;
}

/** An account of a vendor a launch runs. */
type Account = MachineAccount & { vendor: "claude" | "codex" };

const SUBSCRIPTION: Account = {
  name: "work",
  vendor: "claude",
  configDir: "/home/me/.claude-work",
  identity: "me@example.com",
  maxPerAccount: 2,
};

const PROVIDER: Account = {
  name: "router",
  vendor: "claude",
  configDir: "/home/me/.local/state/jig/harness/router",
  identity: providerIdentity(
    "openrouter",
    "op://Jig/router/credential",
    "https://openrouter.ai/api",
  ),
  maxPerAccount: 2,
  provider: {
    harness: "claude-code",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api",
    credential: "op://Jig/router/credential",
    billing: "pay-per-token",
    spendCap: { daily: "20.00", perRun: null, timezone: "UTC" },
    models: null,
  },
};

/** The provider keys `env` holds, by name. */
function providerKeys(env: Record<string, string>): Record<string, string> {
  const names = new Set(PROVIDER_KEYS.map((n) => n.toUpperCase()));
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => names.has(name.toUpperCase())),
  );
}

describe("a launch's environment", () => {
  it("is the same as before for a subscription account, and carries only its own key for a provider account", () => {
    const subscription = passEnvironment(HOST, SUBSCRIPTION);
    const launch = providerLaunchOf(PROVIDER);
    expect(launch).toBeDefined();
    if (launch === undefined) return;
    const provider = providerPassEnvironment(
      HOST,
      PROVIDER,
      launch,
      "resolved-router-key",
    );
    expect(subscription).toEqual(previousPassEnvironment(HOST, SUBSCRIPTION));
    // The subscription account's pass still carries the keys it carried before.
    expect(providerKeys(subscription)).toEqual({
      ANTHROPIC_AUTH_TOKEN: "host-auth-token",
      ANTHROPIC_BASE_URL: "https://elsewhere.example.test",
      OPENROUTER_API_KEY: "host-openrouter",
      GEMINI_API_KEY: "host-gemini",
      GOOGLE_API_KEY: "host-google",
    });
    expect(providerKeys(provider)).toEqual({
      ANTHROPIC_API_KEY: "resolved-router-key",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      JIG_PROVIDER_IDENTITY: PROVIDER.identity,
      JIG_SECRET_VARIABLES: "ANTHROPIC_API_KEY",
    });
    // Everything that is no provider's key is as the subscription account's pass has it.
    const rest = (env: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(env).filter(([name]) => !(name in providerKeys(env))),
      );
    expect(rest(provider)).toEqual({
      ...rest(subscription),
      CLAUDE_CONFIG_DIR: PROVIDER.configDir,
    });
  });

  it("gives a Codex provider account its key under OpenAI's names", () => {
    const codex: Account = {
      ...PROVIDER,
      vendor: "codex",
      provider: {
        ...(PROVIDER.provider as NonNullable<MachineAccount["provider"]>),
        harness: "codex",
        baseUrl: null,
      },
    };
    const launch = providerLaunchOf(codex);
    if (launch === undefined) throw new Error("no provider launch");
    const env = providerPassEnvironment(
      HOST,
      { vendor: "codex", configDir: codex.configDir },
      launch,
      "resolved",
    );
    expect(providerKeys(env)).toEqual({
      OPENAI_API_KEY: "resolved",
      JIG_PROVIDER_IDENTITY: codex.identity,
      JIG_SECRET_VARIABLES: "OPENAI_API_KEY",
    });
    expect(env.CODEX_HOME).toBe(codex.configDir);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("removes a credential or directory variable whatever its letter case", () => {
    const mixed = {
      PATH: "/usr/bin",
      Anthropic_Api_Key: "mixed-anthropic",
      openai_api_key: "mixed-openai",
      Claude_Code_OAuth_Token: "mixed-oauth",
      claude_config_dir: "/another",
      Codex_Home: "/another-codex",
    };
    expect(passEnvironment(mixed, SUBSCRIPTION)).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: SUBSCRIPTION.configDir,
    });
    const launch = providerLaunchOf(PROVIDER);
    if (launch === undefined) throw new Error("no provider launch");
    expect(
      providerPassEnvironment(
        { ...mixed, OpenRouter_Api_Key: "mixed-router" },
        PROVIDER,
        launch,
        null,
      ),
    ).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: PROVIDER.configDir,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      JIG_PROVIDER_IDENTITY: PROVIDER.identity,
    });
  });

  it("drops, in the process runtime, a provider key env_keep keeps for a subscription account's pass", () => {
    const settings = {
      path: "/installed/bin",
      envKeep: ["GEMINI_API_KEY", "GH_TOKEN"],
    };
    const subscription = processEnvironment(
      HOST,
      settings,
      SUBSCRIPTION,
      "record-1",
    );
    expect(subscription.GEMINI_API_KEY).toBe("host-gemini");
    expect(subscription.GH_TOKEN).toBe("forge-fixture");
    const provider = processEnvironment(
      HOST,
      settings,
      PROVIDER,
      "record-2",
      providerLaunchOf(PROVIDER),
    );
    expect({ ...provider }).toEqual({
      HOME: "/home/me",
      LANG: "C.UTF-8",
      PATH: "/installed/bin",
      GH_TOKEN: "forge-fixture",
      CLAUDE_CONFIG_DIR: PROVIDER.configDir,
      JIG_LAUNCH: "record-2",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      JIG_PROVIDER_IDENTITY: PROVIDER.identity,
    });
  });
});
