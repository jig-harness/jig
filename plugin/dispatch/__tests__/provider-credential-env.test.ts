/** The credential command's own variables (`credential_env`): they reach the command, the same way in the tick and the wrapper, and never a pass. */
import { describe, expect, it } from "bun:test";
import { dump } from "../../shared/yaml.ts";
import { passEnvironment, providerPassEnvironment } from "../lib/accounts.ts";
import {
  credentialEnvironment,
  credentialEnvOf,
  namedVariables,
} from "../lib/credential-env.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { resolveCredential } from "../lib/provider-credential.ts";
import { supervisorEnvironment } from "../lib/provider-launch.ts";
import { processEnvironment } from "../lib/runtime/process-environment.ts";

const VAULT = "VAULT_SESSION_FIXTURE";

/** The host's environment: its base, the vault's session, and a variable the command is not given. */
const HOST = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/me",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp",
  [VAULT]: "vault-session-0123456789",
  UNLISTED_FIXTURE: "not-for-the-command",
};

function machine(top: Record<string, unknown> = {}) {
  const parsed = parseMachineConfigText(
    dump({
      credential_command: [process.execPath, "-e", "0"],
      credential_env: [VAULT],
      accounts: [
        {
          name: "router",
          kind: "provider",
          harness: "claude-code",
          provider: "openrouter",
          credential: "op://Jig/router/credential",
          spend_cap: { daily: "20.00" },
        },
      ],
      ...top,
    }),
    "machine",
  );
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  return parsed.value;
}

describe("credential_env", () => {
  it("reaches the credential command with the base, and nothing else of the host's", async () => {
    const config = machine();
    expect(config.credentials?.credentialEnv).toEqual([VAULT]);
    const value = await resolveCredential(
      {
        ...(config.credentials as NonNullable<typeof config.credentials>),
        credentialCommand: [
          process.execPath,
          "-e",
          `process.stdout.write(process.env.${VAULT} + "|" + (process.env.UNLISTED_FIXTURE ?? "unset") + "|" + process.env.HOME)`,
        ],
      },
      "op://Jig/router/credential",
      credentialEnvOf(config, HOST),
    );
    expect(value).toEqual({
      ok: true,
      value: "vault-session-0123456789|unset|/home/me",
    });
  });

  it("reaches no pass, whatever its letter case, and not the supervisor", () => {
    machine();
    const host = { ...HOST, vault_session_fixture: "mixed-case-session" };
    const account = {
      vendor: "claude" as const,
      configDir: "/home/me/.claude-work",
    };
    for (const env of [
      passEnvironment(host, account),
      providerPassEnvironment(
        host,
        account,
        { harness: "claude-code", baseUrl: null, identity: "provider:x:0" },
        "resolved-credential",
      ),
      {
        ...processEnvironment(
          host,
          { envKeep: ["UNLISTED_FIXTURE"] },
          account,
          "record-1",
        ),
      },
      supervisorEnvironment({ id: "record-1" }, host),
    ]) {
      expect(env[VAULT]).toBeUndefined();
      expect(env.vault_session_fixture).toBeUndefined();
      expect(env.UNLISTED_FIXTURE).toBe("not-for-the-command");
    }
  });

  it("is refused where process.env_keep keeps it for every pass, or where it names a base variable", () => {
    const kept = parseMachineConfigText(
      dump({ credential_env: [VAULT], process: { env_keep: [VAULT] } }),
      "machine",
    );
    expect(kept.ok).toBe(false);
    if (!kept.ok)
      expect(kept.failure.reason).toContain("remove it from process.env_keep");
    const base = parseMachineConfigText(
      dump({ credential_env: ["HOME"] }),
      "machine",
    );
    expect(base.ok).toBe(false);
  });

  it("gives the command the same environment in the tick as in the process runtime's wrapper", () => {
    const config = machine({
      runtime: "process",
      process: { path: "/installed/bin" },
    });
    const settings = config.process ?? { envKeep: [] };
    // The process runtime starts a provider account's wrapper with this environment.
    const wrapper = {
      ...processEnvironment(
        HOST,
        settings,
        { vendor: "claude", configDir: "/accounts/router" },
        "record-1",
      ),
      ...namedVariables(HOST, settings.credentialEnv ?? []),
    };
    expect(credentialEnvOf(config, wrapper)).toEqual(
      credentialEnvOf(config, HOST),
    );
    expect(credentialEnvOf(config, HOST)).toEqual(
      credentialEnvironment(HOST, [VAULT], "/installed/bin"),
    );
  });
});
