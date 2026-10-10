/**
 * identity.test.ts — the billing-account identity resolver (`scripts/lib/identity.ts`,
 *).
 *
 * FIXTURES, NOT THE MACHINE'S REAL STATE. Same discipline as `quota.test.ts`:
 * every resolver reads a real on-disk credential file, so pointing it at the
 * developer's own `~/.claude.json` / `~/.codex/auth.json` would make a test
 * pass or fail on whatever happens to be logged in on the machine that runs
 * it. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` are pointed at a fresh tmp directory
 * in `beforeEach`, and `CLAUDE_CODE_OAUTH_TOKEN` is cleared, so every test
 * starts from a clean, controlled slate.
 *
 * WHAT THESE TESTS ARE FOR. `resolveAccountIdentity` is the one place a
 * wrong answer costs something real: `drive.ts` stamps its result into a
 * claim's diagnostics at arm time, and calls it again on its own heartbeat
 * timer whenever no pass is actively running, rewriting the claim when the
 * answer changes (see the module's own header comment). So every branch
 * below pins EITHER a resolved account with its provenance, OR an explicit
 * `null` with a reason — never a silent guess, on either call.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatAccountIdentity,
  passVendor,
  resolveAccountIdentity,
} from "../scripts/lib/identity.ts";

/** Same fingerprint the resolver itself computes — pinned here once so a
 * test can assert the EXACT value rather than merely "some non-null
 * string", without duplicating the hash choice as a second, independently
 * maintained copy. */
function expectedFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

let root: string;
const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "drive-pr-identity-test-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
  process.env.CODEX_HOME = join(root, "codex-home");
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function writeClaudeJson(oauthAccount: unknown): void {
  const dir = process.env.CLAUDE_CONFIG_DIR as string;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount }));
}

/** Base64url-encode a JSON payload as a JWT's middle segment — header and
 * signature are never read by the resolver, so both are junk strings. */
function makeJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function writeCodexAuth(tokens: unknown): void {
  const dir = process.env.CODEX_HOME as string;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens }));
}

describe("passVendor", () => {
  it("recognises claude and codex by argv[0] alone", () => {
    expect(passVendor(["claude", "-p", "hi"])).toBe("claude");
    expect(passVendor(["codex", "exec", "hi"])).toBe("codex");
  });

  it("matches an absolute path by basename", () => {
    expect(passVendor(["/usr/local/bin/claude", "-p", "hi"])).toBe("claude");
    expect(passVendor(["/opt/codex/bin/codex", "exec"])).toBe("codex");
  });

  it("strips a platform binary extension", () => {
    expect(passVendor(["claude.exe", "-p", "hi"])).toBe("claude");
    expect(passVendor(["codex.cmd", "exec"])).toBe("codex");
  });

  it("does not match a name that merely starts with the vendor name", () => {
    // A real hazard the substring form of this check would have missed:
    // a wrapper script named `claude-wrapper` is not the vendor CLI.
    expect(passVendor(["claude-wrapper", "-p", "hi"])).toBeNull();
    expect(passVendor(["claudecode", "-p", "hi"])).toBeNull();
  });

  it("is null for an unrecognized command, or an empty argv", () => {
    expect(passVendor(["sh", "-c", "echo hi"])).toBeNull();
    expect(passVendor([])).toBeNull();
    expect(passVendor([""])).toBeNull();
  });
});

describe("resolveAccountIdentity — claude vendor", () => {
  it("resolves oauthAccount.emailAddress when no token overrides it", () => {
    writeClaudeJson({ emailAddress: "dev@example.com" });
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity).toEqual({
      account: "dev@example.com",
      vendor: "claude",
      provenance: "oauthAccount",
      reason: null,
    });
  });

  it("reports a TOKEN FINGERPRINT, not oauthAccount, when CLAUDE_CODE_OAUTH_TOKEN is set — the two can name different accounts", () => {
    // docs/development/ai-tools/claude-in-chrome-connectivity.md §2: the
    // token, when set, "is the account actually in effect", and
    // oauthAccount can go STALE relative to it (the exact Hearth scenario
    // this module's header comment opens with — a token minted for account
    // B while ~/.claude.json still names account A). Reporting oauthAccount
    // AS the token's account here would silently misattribute billing the
    // moment the two diverge — this pins that they are treated as two
    // different reads, never conflated (docomply-review finding on an
    // earlier revision of this function).
    writeClaudeJson({ emailAddress: "stale-account@example.com" });
    const token = "sk-ant-oat01-fake-token-value";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBe(`token:${expectedFingerprint(token)}`);
    expect(identity.account).not.toContain("stale-account@example.com");
    expect(identity.vendor).toBe("claude");
    expect(identity.provenance).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // The (possibly-stale) oauthAccount read still surfaces, as a hedged
    // hint in provenance — informative without being trusted as identity.
    expect(identity.provenance).toContain("stale-account@example.com");
    expect(identity.reason).toBeNull();
  });

  it("two different tokens for the same oauthAccount fingerprint differently — the whole point is discriminating concurrent drivers", () => {
    writeClaudeJson({ emailAddress: "dev@example.com" });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token-a";
    const a = resolveAccountIdentity(["claude", "-p", "x"]);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token-b";
    const b = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(a.account).not.toBe(b.account);
  });

  it("omits the oauthAccount hint from provenance when .claude.json has none to offer", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-fake-token-value";
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).not.toBeNull();
    expect(identity.provenance).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("reports an API-KEY FINGERPRINT, not oauthAccount, when ANTHROPIC_API_KEY is set — a completely different billing mode from a subscription", () => {
    // API-key billing is pay-per-token against whichever Anthropic Console
    // account owns the key — tracked by Anthropic entirely separately from
    // a .claude.json OAuth session. Reporting oauthAccount here would
    // attribute API-billed work to an unrelated subscription
    // (chatgpt-codex-connector and coderabbitai, PR #4678 round 9).
    writeClaudeJson({ emailAddress: "unrelated-subscription@example.com" });
    const apiKey = "sk-ant-api03-fake-key-value";
    process.env.ANTHROPIC_API_KEY = apiKey;
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBe(`api-key:${expectedFingerprint(apiKey)}`);
    expect(identity.account).not.toContain(
      "unrelated-subscription@example.com",
    );
    expect(identity.vendor).toBe("claude");
    expect(identity.provenance).toBe("ANTHROPIC_API_KEY");
    expect(identity.reason).toBeNull();
  });

  it("prefers CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY when both are set", () => {
    const token = "sk-ant-oat01-fake-token-value";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fake-key-value";
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBe(`token:${expectedFingerprint(token)}`);
    expect(identity.provenance).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("is null with a reason when .claude.json does not exist", () => {
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBeNull();
    expect(identity.vendor).toBe("claude");
    expect(identity.provenance).toBe("oauthAccount");
    expect(identity.reason).toContain(".claude.json");
  });

  it("is null with a reason when .claude.json is not valid JSON", () => {
    const dir = process.env.CLAUDE_CONFIG_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".claude.json"), "not json at all");
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBeNull();
    expect(identity.reason).not.toBeNull();
  });

  it("is null with a reason when oauthAccount is absent", () => {
    writeClaudeJson(undefined);
    const dir = process.env.CLAUDE_CONFIG_DIR as string;
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({}));
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBeNull();
    expect(identity.reason).not.toBeNull();
  });

  it("is null with a reason when emailAddress is missing or not a string", () => {
    writeClaudeJson({ organizationName: "Acme" });
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBeNull();
    expect(identity.reason).not.toBeNull();
  });

  it("honours $CLAUDE_CONFIG_DIR/.claude.json, not ~/.claude.json", () => {
    // The effective path is the whole point of ADR-0078's per-slot
    // provisioning (`CLAUDE_CONFIG_DIR=~/.forge/slots/<slot>/claude`) — a
    // resolver that fell back to the real home directory would read a
    // DIFFERENT account than the one the pass will actually use.
    writeClaudeJson({ emailAddress: "slot-account@example.com" });
    const identity = resolveAccountIdentity(["claude", "-p", "x"]);
    expect(identity.account).toBe("slot-account@example.com");
  });
});

describe("resolveAccountIdentity — codex vendor", () => {
  it("resolves the email claim from tokens.id_token", () => {
    const idToken = makeJwt({ email: "dev@example.com", sub: "abc" });
    writeCodexAuth({
      id_token: idToken,
      access_token: "x",
      refresh_token: "y",
      account_id: "6bc1d13b-14db-4326-b7e6-f3c858488e5c",
    });
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity).toEqual({
      account: "dev@example.com",
      vendor: "codex",
      provenance: "CODEX_HOME auth.json",
      reason: null,
    });
  });

  it("falls back to tokens.account_id when the JWT carries no email claim", () => {
    const idToken = makeJwt({ sub: "abc" }); // no `email`
    writeCodexAuth({
      id_token: idToken,
      account_id: "6bc1d13b-14db-4326-b7e6-f3c858488e5c",
    });
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity).toEqual({
      account: "6bc1d13b-14db-4326-b7e6-f3c858488e5c",
      vendor: "codex",
      provenance: "CODEX_HOME auth.json (account_id — no email claim)",
      reason: null,
    });
  });

  it("falls back to tokens.account_id when id_token is not a well-formed JWT", () => {
    writeCodexAuth({
      id_token: "not-a-jwt",
      account_id: "6bc1d13b-14db-4326-b7e6-f3c858488e5c",
    });
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBe("6bc1d13b-14db-4326-b7e6-f3c858488e5c");
  });

  it("is null with a reason when neither an email claim nor account_id is available", () => {
    writeCodexAuth({ id_token: makeJwt({ sub: "abc" }) });
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBeNull();
    expect(identity.vendor).toBe("codex");
    expect(identity.reason).not.toBeNull();
  });

  it("is null with a reason when auth.json does not exist", () => {
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBeNull();
    expect(identity.reason).toContain("auth.json");
  });

  it("is null with a reason when auth.json is not valid JSON", () => {
    const dir = process.env.CODEX_HOME as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), "not json");
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBeNull();
    expect(identity.reason).not.toBeNull();
  });

  it("honours $CODEX_HOME/auth.json, not ~/.codex/auth.json", () => {
    writeCodexAuth({ id_token: makeJwt({ email: "slot@example.com" }) });
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBe("slot@example.com");
  });

  it("reports an API-KEY FINGERPRINT, not auth.json, when OPENAI_API_KEY is set — Codex sibling to the Claude ANTHROPIC_API_KEY branch", () => {
    // passEnv() forwards this process's environment unchanged to a `codex`
    // pass, so a key-authenticated pass bills against the Console account
    // that owns the key, never against whatever auth.json happens to hold —
    // reading auth.json regardless would attribute API-billed work to an
    // unrelated leftover ChatGPT identity (chatgpt-codex-connector, PR
    // #4678 round 5).
    writeCodexAuth({ id_token: makeJwt({ email: "unrelated@example.com" }) });
    const apiKey = "sk-fake-openai-key-value";
    process.env.OPENAI_API_KEY = apiKey;
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBe(`api-key:${expectedFingerprint(apiKey)}`);
    expect(identity.account).not.toContain("unrelated@example.com");
    expect(identity.vendor).toBe("codex");
    expect(identity.provenance).toBe("OPENAI_API_KEY");
    expect(identity.reason).toBeNull();
  });

  it('reads a persisted `codex login --with-api-key` key when no env var is set — the CLI writes {auth_mode:"apikey",OPENAI_API_KEY:"<key>"} at the top level, no tokens at all (chatgpt-codex-connector, a reference-implementation pull request round 8; shape verified against a real login run into an isolated $CODEX_HOME)', () => {
    const dir = process.env.CODEX_HOME as string;
    mkdirSync(dir, { recursive: true });
    const persistedKey = "sk-fake-persisted-key-value";
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: persistedKey }),
    );
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBe(
      `api-key:${expectedFingerprint(persistedKey)}`,
    );
    expect(identity.vendor).toBe("codex");
    expect(identity.provenance).toBe(
      "CODEX_HOME auth.json (auth_mode: apikey)",
    );
    expect(identity.reason).toBeNull();
  });

  it('falls through to the tokens-based reads when auth_mode is not "apikey", even if OPENAI_API_KEY happens to be present', () => {
    // The real CLI writes a null OPENAI_API_KEY alongside auth_mode:"chatgpt"
    // and a populated `tokens` object — measured on a real ChatGPT-mode
    // auth.json. A non-"apikey" auth_mode must not be trusted to carry a
    // real key.
    const dir = process.env.CODEX_HOME as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: { id_token: makeJwt({ email: "chatgpt-mode@example.com" }) },
      }),
    );
    const identity = resolveAccountIdentity(["codex", "exec", "hi"]);
    expect(identity.account).toBe("chatgpt-mode@example.com");
    expect(identity.provenance).toBe("CODEX_HOME auth.json");
  });
});

describe("resolveAccountIdentity — unrecognized vendor", () => {
  it("is null, vendor null, with a reason naming only argv[0]'s basename — never a guess", () => {
    // Vendor comes from argv[0] alone, never from probing every vendor's
    // state — a wrong guess here would attribute billing to the WRONG
    // account, not merely miss a detection (see the module's header comment
    // for why that is a different failure mode than quota-wall detection).
    const identity = resolveAccountIdentity(["sh", "-c", "echo hi"]);
    expect(identity).toEqual({
      account: null,
      vendor: null,
      provenance: "pass command",
      reason:
        "pass command 'sh' does not name a recognized vendor (claude/codex)",
    });
  });

  it("never embeds the rest of the pass argv in the reason — it is persisted to the claim file and echoed on every listing", () => {
    // A pass command can be an operator's own wrapper carrying a secret in
    // its own arguments (`env VAR=secret claude -p ...`) — the reason must
    // name only argv[0]'s basename, never argv[1:], or that secret would be
    // written to disk and re-printed by every `drives.ts` listing and
    // exit-11 refusal for the life of the drive (docomply-review).
    const identity = resolveAccountIdentity([
      "env",
      "SECRET_TOKEN=do-not-leak-me",
      "claude",
      "-p",
      "x",
    ]);
    expect(identity.reason).not.toContain("do-not-leak-me");
    expect(identity.reason).toContain("env");
  });

  it("does not touch the filesystem for an unrecognized vendor — a real credential file is left completely unread", () => {
    // A vacuous fixture (pointing both config roots at a directory that does
    // not exist) would pass identically whether or not the vendor gate is
    // even present, since a missing-file read already degrades to null on
    // its own (.claude/rules/document-scanning-gates.md §5's "reviewer-
    // supplied decoy that already fails closed" trap). Plant a REAL,
    // resolvable credential file instead, so removing the `if (vendor ===
    // 'claude')` gate would make this test start returning that email
    // instead of null.
    writeClaudeJson({ emailAddress: "leaked@example.com" });
    writeCodexAuth({ id_token: makeJwt({ email: "also-leaked@example.com" }) });
    const identity = resolveAccountIdentity(["sh", "-c", "echo hi"]);
    expect(identity.account).toBeNull();
    expect(identity.vendor).toBeNull();
  });
});

describe("formatAccountIdentity", () => {
  it("renders a resolved account with its vendor and provenance", () => {
    expect(
      formatAccountIdentity({
        account: "dev@example.com",
        vendor: "claude",
        provenance: "CLAUDE_CODE_OAUTH_TOKEN",
        reason: null,
      }),
    ).toBe("dev@example.com (claude, from CLAUDE_CODE_OAUTH_TOKEN)");
  });

  it("renders an unresolved account as unknown, with its reason", () => {
    expect(
      formatAccountIdentity({
        account: null,
        vendor: null,
        provenance: "pass command",
        reason:
          "pass command 'sh -c echo hi' does not name a recognized vendor (claude/codex)",
      }),
    ).toBe(
      "unknown (pass command 'sh -c echo hi' does not name a recognized vendor (claude/codex))",
    );
  });
});
