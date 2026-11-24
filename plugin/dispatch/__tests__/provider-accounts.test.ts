/** The machine file's provider accounts: what loads, what is refused, and the identity each derives. */
import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { dump } from "../../shared/yaml.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { providerIdentity } from "../lib/provider-account.ts";

const COMMAND = { credential_command: ["op", "read", "--no-newline"] };

/** A pay-per-token provider account with `fields` over its defaults. */
function router(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "router",
    kind: "provider",
    harness: "claude-code",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api",
    credential: "op://Jig/router/credential",
    spend_cap: { daily: "20.00" },
    ...fields,
  };
}

function load(accounts: unknown[], top: Record<string, unknown> = COMMAND) {
  return parseMachineConfigText(dump({ accounts, ...top }), "machine");
}

function refusal(accounts: unknown[], top?: Record<string, unknown>): string {
  const parsed = load(accounts, top);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? "" : parsed.failure.reason;
}

describe("a provider account", () => {
  it("loads with a derived identity, its harness's vendor and a directory of its own", () => {
    const parsed = load([
      router({
        base_url: "https://openrouter.ai/api",
        spend_cap: {
          daily: "20.00",
          per_run: "2.50",
          timezone: "Europe/Amsterdam",
        },
        models: [{ id: "some-model", price: { input: "3.00", output: "15" } }],
        stages: ["rearm"],
      }),
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [account] = parsed.value.accounts;
    expect(account).toEqual({
      name: "router",
      vendor: "claude",
      configDir: join(homedir(), ".local", "state", "jig", "harness", "router"),
      identity: providerIdentity(
        "openrouter",
        "op://Jig/router/credential",
        "https://openrouter.ai/api",
      ),
      maxPerAccount: 2,
      stages: ["rearm"],
      provider: {
        harness: "claude-code",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api",
        credential: "op://Jig/router/credential",
        billing: "pay-per-token",
        spendCap: {
          daily: "20.00",
          perRun: "2.50",
          timezone: "Europe/Amsterdam",
        },
        models: [{ id: "some-model", price: { input: "3.00", output: "15" } }],
      },
    });
    expect(account?.identity).toMatch(/^provider:openrouter:[0-9a-f]{12}$/);
    expect(parsed.value.credentials).toEqual({
      credentialCommand: ["op", "read", "--no-newline"],
      credentialTimeoutMs: 10_000,
      credentialEnv: [],
      providerHosts: {},
    });
  });

  it("derives one identity from the reference and the base URL, and another for either changed", () => {
    const one = providerIdentity("gemini", "op://a/b/c", null);
    expect(providerIdentity("gemini", "op://a/b/c", null)).toBe(one);
    expect(providerIdentity("gemini", "op://a/b/d", null)).not.toBe(one);
    expect(
      providerIdentity("gemini", "op://a/b/c", "https://example.test"),
    ).not.toBe(one);
  });

  it("refuses a credential value written where its reference belongs, withholding the value", () => {
    for (const value of [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "plain-secret-value-0123456789",
      "op://Jig/sk-or-v1-0123456789abcdef0123456789abcdef",
      "op://Jig/item with space/field",
      "Bearer abcdefghijklmnopqrstuvwxyz",
    ]) {
      const reason = refusal([router({ credential: value })]);
      expect(reason).toContain("accounts[0] (router).credential");
      expect(reason).toContain("never the credential itself");
      expect(reason).not.toContain(value);
    }
  });

  it("refuses a reference with a NUL, and an empty query or fragment on the base URL", () => {
    expect(
      refusal([router({ credential: "op://Jig/a\u0000b/field" })]),
    ).toContain("never the credential itself");
    for (const url of [
      "https://openrouter.ai/api?",
      "https://openrouter.ai/api#",
    ])
      expect(refusal([router({ base_url: url })])).toContain(
        "no query or fragment",
      );
  });

  it("refuses a base URL the parser would normalize past the path checks", () => {
    for (const url of [
      "https://openrouter.ai\\api\\..\\x",
      "https://openrouter.ai/api/\t./x",
      "https://openrouter.ai/api/\n../x",
      "https:///openrouter.ai/api",
    ])
      expect(refusal([router({ base_url: url })])).toMatch(
        /plain URL|no percent escapes|no credential-shaped value/,
      );
  });

  it("refuses a base URL written with a leading or trailing space or line break", () => {
    for (const url of [
      " https://openrouter.ai/api",
      "https://openrouter.ai/api\n",
      "\thttps://openrouter.ai/api",
      "\u00a0https://openrouter.ai/api",
      "https://openrouter.ai/api\u00a0",
    ])
      expect(refusal([router({ base_url: url })])).toContain("plain URL");
  });

  it("refuses a base URL path with a percent escape or a credential shape, naming neither", () => {
    for (const path of [
      "/api/%FF",
      "/api/%2573k-AAAAAAAAAAAA",
      "/api/sk-AAAAAAAAAAAA",
      "/api/%2e",
      "/api/sk-AAAAAAAAAAAA/..",
      "/api/./x",
    ]) {
      const reason = refusal([
        router({ base_url: `https://openrouter.ai${path}` }),
      ]);
      expect(reason).toMatch(/no percent escapes|no credential-shaped value/);
      expect(reason).not.toContain("AAAAAAAAAAAA");
    }
  });

  it("keeps a base URL's path as written, dropping only the root slash", () => {
    const url = (base_url: string) => {
      const parsed = load([router({ base_url })]);
      expect(parsed.ok).toBe(true);
      return parsed.ok ? JSON.stringify(parsed.value) : "";
    };
    expect(url("https://openrouter.ai/api/")).toContain("openrouter.ai/api/");
    expect(url("https://openrouter.ai/")).toContain('"https://openrouter.ai"');
  });

  it("loads a flat-rate plan with no spend cap, and refuses one given a cap", () => {
    const flat = load(
      [
        router({
          billing: "flat-rate",
          spend_cap: undefined,
          provider: "zai",
          base_url: "https://api.z.ai/api",
        }),
      ],
      { ...COMMAND, provider_hosts: { zai: ["api.z.ai"] } },
    );
    expect(flat.ok).toBe(true);
    if (flat.ok)
      expect(flat.value.accounts[0]?.provider).toMatchObject({
        billing: "flat-rate",
        spendCap: null,
      });
    expect(refusal([router({ billing: "flat-rate" })])).toContain(
      "spend_cap is for a pay-per-token key",
    );
  });

  it("refuses a pay-per-token account with no daily cap, and a cap that is not a positive dollar string", () => {
    expect(refusal([router({ spend_cap: undefined })])).toContain(
      "spend_cap.daily is required for a pay-per-token account",
    );
    expect(refusal([router({ spend_cap: { per_run: "1.00" } })])).toContain(
      "spend_cap.daily is required",
    );
    expect(refusal([router({ spend_cap: { daily: "0.00" } })])).toContain(
      "must be more than 0",
    );
    expect(refusal([router({ spend_cap: { daily: 20 } })])).toContain(
      "quoted string",
    );
    expect(
      refusal([router({ spend_cap: { daily: "20", per_run: "-1" } })]),
    ).toContain("decimal US dollars");
    expect(
      refusal([router({ spend_cap: { daily: "20", timezone: "Mars/Base" } })]),
    ).toContain("time zone name");
    expect(
      refusal([router({ spend_cap: { daily: "20", weekly: "100" } })]),
    ).toContain("unknown key(s): weekly");
  });

  it("refuses a provider account when the machine file names no credential command", () => {
    expect(refusal([router()], {})).toContain(
      "names no credential_command to resolve its credential",
    );
    expect(refusal([router()], { credential_command: [] })).toContain(
      "credential_command must be a nonempty list",
    );
  });

  it("holds a base URL to https on the provider's own host or one provider_hosts names", () => {
    expect(
      refusal([router({ base_url: "http://openrouter.ai/api" })]),
    ).toContain("must be an https:// URL");
    expect(
      refusal([router({ base_url: "https://proxy.example.test/v1" })]),
    ).toContain("not openrouter's own API");
    expect(
      refusal([router({ base_url: "https://user:pw@openrouter.ai/api" })]),
    ).toContain("no user name or password");
    for (const base_url of [
      "https://@openrouter.ai/api",
      "https://:@openrouter.ai/api",
    ])
      expect(refusal([router({ base_url })])).toContain(
        "no user name or password",
      );
    const pathAt = load([
      router({ base_url: "https://openrouter.ai/api/@stable" }),
    ]);
    expect(pathAt.ok).toBe(true);
    if (pathAt.ok)
      expect(pathAt.value.accounts[0]?.provider?.baseUrl).toBe(
        "https://openrouter.ai/api/@stable",
      );
    expect(
      refusal([router({ base_url: "https://openrouter.ai/api?key=x" })]),
    ).toContain("no query or fragment");
    expect(refusal([router({ base_url: "http://127.0.0.1:4000" })])).toContain(
      "not openrouter's own API",
    );
    const named = load(
      [
        router({ base_url: "http://127.0.0.1:4000" }),
        router({
          name: "proxied",
          base_url: "https://proxy.example.test/v1",
        }),
      ],
      {
        ...COMMAND,
        provider_hosts: { openrouter: ["127.0.0.1", "proxy.example.test"] },
      },
    );
    expect(named.ok).toBe(true);
  });

  it("refuses an unknown key, a subscription's vendor or identity, and an unregistered harness", () => {
    expect(refusal([router({ vendor: "claude" })])).toContain(
      "unknown key(s): vendor",
    );
    expect(refusal([router({ identity: "me@example.com" })])).toContain(
      "unknown key(s): identity",
    );
    expect(refusal([router({ harness: "pi" })])).toContain(
      "must be a registered harness (claude-code, codex): pi",
    );
    expect(refusal([router({ provider: "Open Router" })])).toContain(
      "provider must be a provider's name",
    );
    expect(refusal([{ ...router(), kind: "rental" }])).toContain(
      "kind must be subscription or provider",
    );
  });

  it("keeps a provider account's directory its own, across both kinds", () => {
    const shared = join(homedir(), ".claude-work");
    expect(
      refusal([
        {
          name: "work",
          vendor: "claude",
          config_dir: shared,
          identity: "me@example.com",
        },
        router({ harness: "codex", config_dir: shared }),
      ]),
    ).toContain("an account configuration directory listed twice");
  });
});

describe("a subscription account", () => {
  it("loads as before, and takes kind: subscription and its vendor's own harness", () => {
    const entry = {
      name: "work",
      vendor: "claude",
      config_dir: "/home/me/.claude-work",
      identity: "me@example.com",
    };
    const before = load([entry], {});
    const named = load(
      [{ ...entry, kind: "subscription", harness: "claude-code" }],
      {},
    );
    expect(before.ok && named.ok).toBe(true);
    if (before.ok && named.ok)
      expect(named.value.accounts).toEqual(before.value.accounts);
    if (before.ok)
      expect(before.value.accounts[0]).toEqual({
        name: "work",
        vendor: "claude",
        configDir: "/home/me/.claude-work",
        identity: "me@example.com",
        maxPerAccount: 2,
      });
  });

  it("refuses a Claude subscription with any harness but Claude Code's", () => {
    expect(
      refusal(
        [
          {
            name: "work",
            vendor: "claude",
            harness: "codex",
            config_dir: "/home/me/.claude-work",
            identity: "me@example.com",
          },
        ],
        {},
      ),
    ).toContain("harness must be claude-code");
  });

  it("refuses an omitted base_url unless the harness's own default is the provider", () => {
    expect(refusal([router({ base_url: undefined })])).toContain(
      "base_url is required for openrouter on claude-code",
    );
    expect(
      load([
        router({ provider: "anthropic", base_url: undefined, name: "own" }),
      ]).ok,
    ).toBe(true);
  });

  it("reads a provider named like an inherited property as unknown, not as its host list", () => {
    const outcome = load([
      router({
        provider: "constructor",
        base_url: "https://openrouter.ai/api",
      }),
    ]);
    expect(outcome.ok).toBe(false);
    expect(refusal([router({ provider: "constructor" })])).toContain(
      "provider_hosts.constructor",
    );
  });
});
