/** A provider account's credential, resolved through the host's command, and what a refusal holds. */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { accountStartupNeeds } from "../lib/account-startup.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import {
  allowListOf,
  prelaunchCredential,
} from "../lib/actions/provider-check.ts";
import { providerRefusal } from "../lib/provider-allow.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import {
  type CredentialSettings,
  providerIdentity,
} from "../lib/provider-account.ts";
import { maskCredentials, redactExact } from "../../shared/credentials.ts";
import { resolveCredential } from "../lib/provider-credential.ts";
import { existingStateDb } from "../lib/state.ts";
import { accountWall } from "../lib/walls.ts";

/** A credential command that runs `script` with Bun, the reference its last argument. */
function command(script: string, timeoutMs = 10_000): CredentialSettings {
  return {
    credentialCommand: [process.execPath, "-e", script],
    credentialTimeoutMs: timeoutMs,
    credentialEnv: [],
    providerHosts: {},
  };
}

/** A credential command that uses the shell only to leave a child process behind. */
function shellCommand(script: string, timeoutMs = 10_000): CredentialSettings {
  return {
    credentialCommand: ["sh", "-c", script],
    credentialTimeoutMs: timeoutMs,
    credentialEnv: [],
    providerHosts: {},
  };
}

const ECHO_REFERENCE =
  "process.stdout.write('value-for:' + process.argv.at(-1) + '\\n')";
const REFUSE =
  "process.stdout.write('half-printed-secret-0123'); process.stderr.write('vault says no for half-printed-secret-0123\\n'); process.exit(1)";

const ROUTER: MachineAccount = {
  name: "router",
  vendor: "claude",
  configDir: "/accounts/router",
  identity: providerIdentity("openrouter", "op://Jig/router/credential", null),
  maxPerAccount: 2,
  provider: {
    harness: "claude-code",
    provider: "openrouter",
    baseUrl: null,
    credential: "op://Jig/router/credential",
    billing: "pay-per-token",
    spendCap: { daily: "20.00", perRun: null, timezone: "UTC" },
    models: null,
  },
};

describe("resolving a credential reference", () => {
  it("removes one CRLF, refuses a NUL, and counts the length masking counts", async () => {
    const crlf = await resolveCredential(
      command("process.stdout.write('crlf-secret-value\\r\\n')"),
      "ref",
      process.env,
    );
    expect(crlf.ok && crlf.value).toBe("crlf-secret-value");
    const nul = await resolveCredential(
      command("process.stdout.write('nul-secret\\0value')"),
      "ref",
      process.env,
    );
    expect(!nul.ok && nul.failure.reason).toContain("NUL");
    // Three characters, nine bytes: exact masking could not replace it.
    const wide = await resolveCredential(
      command("process.stdout.write('\\u20ac\\u20ac\\u20ac')"),
      "ref",
      process.env,
    );
    expect(!wide.ok && wide.failure.reason).toContain("8 characters");
  });

  it("keeps a 4 KiB value whose command also prints 5 KiB of diagnostics", async () => {
    const done = await resolveCredential(
      command(
        "process.stdout.write('k'.repeat(4096)); process.stderr.write('d'.repeat(5120))",
      ),
      "ref",
      process.env,
    );
    expect(done.ok && done.value).toBe("k".repeat(4096));
  });

  it("keeps a 4 KiB value whose command prints diagnostics past the old combined limit", async () => {
    const done = await resolveCredential(
      command(
        "process.stdout.write('k'.repeat(4096)); process.stderr.write('d'.repeat(20000))",
      ),
      "ref",
      process.env,
    );
    expect(done.ok && done.value).toBe("k".repeat(4096));
  });

  it("refuses a value with a malformed byte, which decodes to U+FFFD", async () => {
    const bad = await resolveCredential(
      command(
        "process.stdout.write(Buffer.from([0x61,0x62,0x63,0x64,0x65,0x66,0x67,0x68,0xff,0x69]))",
      ),
      "ref",
      process.env,
    );
    expect(!bad.ok && bad.failure.reason).toContain("not valid UTF-8");
  });

  it("prints the value for the reference appended as one argument, one trailing newline removed", async () => {
    const value = await resolveCredential(
      command(ECHO_REFERENCE),
      "op://Vault/an item/a 'field'",
      process.env,
    );
    expect(value).toEqual({
      ok: true,
      value: "value-for:op://Vault/an item/a 'field'",
    });
  });

  it("is unauthorized for a non-zero exit, an empty value, a value with a line break or one over 4 KiB", async () => {
    const cases: Array<[string, string]> = [
      [REFUSE, "the credential command exited 1"],
      ["process.stdout.write('\\n')", "printed no value"],
      ["process.stdout.write('one\\ntwo')", "line break inside it"],
      ["process.stdout.write('x'.repeat(4097))", "over 4 KiB"],
      ["process.stdout.write('short')", "under 8 characters"],
      [
        "process.stdout.write('half-printed-secret-line-one\\nhalf-printed-secret-line-two'); process.stderr.write('refused half-printed-secret-line-two\\n'); process.exit(1)",
        "the credential command exited 1; its error output is not recorded",
      ],
    ];
    for (const [script, why] of cases) {
      const value = await resolveCredential(
        command(script),
        "op://a/b/c",
        process.env,
      );
      expect(value.ok).toBe(false);
      if (value.ok) continue;
      expect(value.failure.code).toBe("unauthorized");
      expect(value.failure.reason).toContain(why);
      expect(value.failure.reason).not.toContain("half-printed-secret");
    }
    expect(
      await resolveCredential(
        { ...command(ECHO_REFERENCE), credentialCommand: null },
        "op://a/b/c",
        process.env,
      ),
    ).toMatchObject({ ok: false, failure: { code: "unauthorized" } });
  });

  it("refuses a part of a redaction marker, including a complete marker inside a longer value", async () => {
    for (const printed of [
      "redacted",
      "<redacted",
      "launch token",
      "oversized line",
      "[redacted: oversized line dropped]",
      "opaque-value-<redacted>-inside",
    ]) {
      const value = await resolveCredential(
        command(`process.stdout.write(${JSON.stringify(printed)})`),
        "ref",
        process.env,
      );
      expect(value).toMatchObject({
        ok: false,
        failure: { code: "unauthorized" },
      });
    }
    const usable = await resolveCredential(
      command("process.stdout.write('REDACTED')"),
      "ref",
      process.env,
    );
    expect(usable.ok).toBe(true);
  });

  it("does not remember a refused marker, but remembers opaque failed output around it", async () => {
    await resolveCredential(
      command("process.stdout.write('redacted')"),
      "ref",
      process.env,
    );
    await resolveCredential(
      command(
        "process.stdout.write('launch token\\nopaque-failed-secret-1234 <redacted>'); process.exit(1)",
      ),
      "ref",
      process.env,
    );
    const masked = maskCredentials(
      "a <redacted> b [launch token] c redacted [redacted: oversized line dropped] d opaque-failed-secret-1234",
      "<redacted>",
    );
    expect(masked).toBe(
      "a <redacted> b [launch token] c redacted [redacted: oversized line dropped] d <redacted>",
    );
    expect(masked).toContain("[launch token]");
    expect(masked).toContain("[redacted: oversized line dropped]");
    expect(masked).toContain("<redacted>");
  });

  it("remembers a complete failed-output value even when its marker-separated fragments are short", async () => {
    const opaque = "prefix<redacted>suffix";
    await resolveCredential(
      command(
        `process.stdout.write(${JSON.stringify(opaque)}); process.exit(1)`,
      ),
      "ref",
      process.env,
    );
    expect(maskCredentials(`value ${opaque}`, "[masked]")).toBe(
      "value [masked]",
    );
    expect(maskCredentials("<redacted>", "[masked]")).toBe("<redacted>");
  });

  it("masks the union of overlapping exact credential values", () => {
    expect(
      redactExact(
        "longer-prefix-fixture<redacted>abcdef0123456789",
        "[masked]",
        ["longer-prefix-fixture<redacted>abcdef", "abcdef0123456789"],
      ),
    ).toBe("[masked]");
  });

  it("learns trimmed failed-output lines and marker-collision output", async () => {
    const trimmed = "trimmed-opaque-secret-1234";
    const stderrOnly = "opaque-stderr-diagnostic-1234";
    const failed = await resolveCredential(
      command(
        `process.stdout.write('pre\\n  ${trimmed}  \\npost'); process.stderr.write(${JSON.stringify(stderrOnly)}); process.exit(1)`,
      ),
      "ref",
      process.env,
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected the credential command to fail");
    expect(failed.failure).toEqual({
      code: "unauthorized",
      reason:
        "the credential command exited 1; its error output is not recorded",
    });
    expect(failed.failure.reason).not.toContain(stderrOnly);
    expect(maskCredentials(`pre\n  ${trimmed}  \npost`, "[masked]")).toBe(
      "pre\n[masked]\npost",
    );

    const collision = "marker-collision-secret-1234";
    const refused = await resolveCredential(
      command(`process.stdout.write('prefix<redacted>${collision}')`),
      "ref",
      process.env,
    );
    expect(refused).toMatchObject({
      ok: false,
      failure: { reason: expect.stringContaining("redaction marker") },
    });
    expect(maskCredentials(`value ${collision}`, "[masked]")).toBe(
      "value [masked]",
    );
    expect(
      maskCredentials(`value prefix<redacted>${collision}`, "[masked]"),
    ).toBe("value [masked]");
    expect(maskCredentials("<redacted>", "[masked]")).toBe("<redacted>");
  });

  it("does not relay a failed credential command's stderr to its parent", async () => {
    const stderrOnly = "opaque-stderr-diagnostic-1234";
    const stdoutSentinel = "credential-command-ran-1234";
    const sentinelDirectory = mkdtempSync(
      join(tmpdir(), "provider-credential-"),
    );
    const sentinelPath = join(sentinelDirectory, "ran");
    const credentialModule = new URL(
      "../lib/provider-credential.ts",
      import.meta.url,
    ).href;
    const source = `
      import { resolveCredential } from ${JSON.stringify(credentialModule)};
      const result = await resolveCredential({
        credentialCommand: [process.execPath, "--no-env-file", "-e", ${JSON.stringify(
          `require("node:fs").writeSync(2, ${JSON.stringify(stderrOnly)}); require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, ${JSON.stringify(stdoutSentinel)}); process.exit(43)`,
        )}],
        credentialTimeoutMs: 10_000,
        credentialEnv: [],
        providerHosts: {},
      }, "ref", process.env);
      if (result.ok) throw new Error("expected credential command failure");
      console.log(result.failure.reason);
    `;
    try {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "-e", source],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: process.env.PATH ?? "" },
          timeout: 15_000,
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expectSpawnExit(
        { exitCode, stdout, stderr },
        0,
        "credential resolver child",
      );
      expect(stdout).toBe(
        "the credential command exited 43; its error output is not recorded\n",
      );
      expect(readFileSync(sentinelPath, "utf8")).toBe(stdoutSentinel);
      expect(stdout).not.toContain(stderrOnly);
      expect(stderr).toBe("");
    } finally {
      rmSync(sentinelDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("is unreachable when the command does not answer in time", async () => {
    const printed = "timed-out-secret-1234";
    const value = await resolveCredential(
      command(
        `process.stdout.write(${JSON.stringify(printed)}); await Bun.sleep(10_000)`,
        1_000,
      ),
      "op://a/b/c",
      process.env,
    );
    expect(value).toMatchObject({
      ok: false,
      failure: { code: "unreachable" },
    });
    expect(maskCredentials(`value ${printed}`, "[masked]")).toBe(
      "value [masked]",
    );
  }, 10_000);

  it("refuses and masks output when the command leaves its process group alive", async () => {
    const printed = "surviving-group-secret-1234";
    const value = await resolveCredential(
      shellCommand(`printf %s ${JSON.stringify(printed)}; sleep 30 &`),
      "ref",
      process.env,
    );
    expect(value).toMatchObject({
      ok: false,
      failure: {
        code: "unauthorized",
        reason: expect.stringContaining("background process"),
      },
    });
    expect(maskCredentials(`value ${printed}`, "[masked]")).toBe(
      "value [masked]",
    );
  });
});

describe("a provider account's credential before a launch", () => {
  function state(settings: CredentialSettings, root: string): ApplyState {
    return {
      machine: { credentials: settings, wallBackoffMs: 3_600_000 },
      root,
    } as unknown as ApplyState;
  }

  it("refuses when the command fails: unauthorized, the account held, and one need however often it fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-credential-"));
    const refused = state(command(REFUSE), root);
    for (let i = 0; i < 2; i++) {
      const answer = await prelaunchCredential(
        refused,
        ROUTER,
        { ok: true },
        true,
      );
      expect(answer).toEqual({
        ok: false,
        reason: expect.stringMatching(
          /^unauthorized: the credential command exited 1/,
        ),
      });
    }
    expect(accountWall(ROUTER, Date.now(), root)?.source).toContain(
      "the credential was refused (unauthorized)",
    );
    const needs = accountStartupNeeds([ROUTER], root);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({
      cause: "account-sign-in",
      repo: "host",
      target: "account router",
      reason: expect.stringContaining(
        "make its reference op://Jig/router/credential resolve",
      ),
    });
    // The refusal itself is what is asserted; the caller's reservation (`holdRecord`) is not exercised here, so an empty table shows only that this function writes no launch.
    const launches = existingStateDb(root)
      ?.query("SELECT COUNT(*) AS n FROM launches")
      .get() as { n: number } | undefined;
    expect(launches?.n ?? 0).toBe(0);
    // A resolution that succeeds again lifts the need.
    const answered = await prelaunchCredential(
      state(command(ECHO_REFERENCE), root),
      ROUTER,
      { ok: true },
      true,
    );
    expect(answered).toEqual({ ok: true });
    expect(accountStartupNeeds([ROUTER], root)).toEqual([]);
  });

  it("waits for the next tick when the command does not answer, holding nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-credential-"));
    const answer = await prelaunchCredential(
      state(command("await Bun.sleep(10_000)", 1000), root),
      ROUTER,
      { ok: true },
      true,
    );
    expect(answer).toMatchObject({
      waits: expect.stringContaining("unreachable"),
      waitsOn: "accounts",
    });
    expect(accountWall(ROUTER, Date.now(), root)).toBeNull();
    expect(accountStartupNeeds([ROUTER], root)).toEqual([]);
  });
});

describe("the allow list a launch is checked against", () => {
  it("refuses every account for a repository a tick read no list for, and applies none where it read no lists", () => {
    const read = {
      allowedProviders: new Map([["example-org/alpha", ["anthropic"]]]),
    } as unknown as ApplyState;
    expect(allowListOf(read, "example-org/alpha")).toEqual({
      repo: "example-org/alpha",
      providers: ["anthropic"],
    });
    const missing = allowListOf(read, "example-org/beta");
    expect(missing).toEqual({
      repo: "example-org/beta",
      providers: null,
      unread: true,
    });
    expect(
      providerRefusal({ name: "work", vendor: "claude" }, missing),
    ).toContain("was not read this tick");
    expect(allowListOf({} as ApplyState, "example-org/beta")).toEqual({
      repo: "example-org/beta",
      providers: null,
    });
  });
});
