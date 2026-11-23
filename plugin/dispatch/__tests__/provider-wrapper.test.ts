/**
 * A provider account's launch through the real wrapper: it resolves the
 * credential, hands it to its supervisor, which takes it out of its own
 * environment before the stage starts; the stage carries the key and none
 * of the handoff or the credential command's variables, and nothing the
 * launch recorded holds the value.
 */
import { afterEach, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { dump } from "../../shared/yaml.ts";
import { providerIdentity } from "../lib/provider-account.ts";
import { type World, world } from "./fixtures.ts";
import {
  dispatchState,
  driveRuns,
  earlierRecord,
  exitWritten,
} from "./launch-fixtures.ts";

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const SENTINEL = "sentinel-wrapper-credential-4d2b8e";
const VAULT = "VAULT_SESSION_FIXTURE";
const REFERENCE = "op://Jig/router/credential";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** Every file under `dir`, recursively. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

it.skipIf(process.platform === "win32")(
  "hands the resolved credential through the supervisor to the stage and to nothing it records",
  async () => {
    const w = world();
    current = w;
    const configDir = join(w.root, "config-router");
    mkdirSync(configDir, { recursive: true });
    // The command needs the vault's session, which only credential_env gives it.
    const command = join(w.root, "credential.ts");
    writeFileSync(
      command,
      `if (process.env.${VAULT} !== "vault-session-fixture") process.exit(1);\nprocess.stdout.write(${JSON.stringify(`${SENTINEL}\n`)});\n`,
    );
    mkdirSync(join(w.home, ".jig"), { recursive: true });
    writeFileSync(
      join(w.home, ".jig", "dispatch.yaml"),
      dump({
        repositories: [{ path: w.repo, stages: ["rearm"] }],
        credential_command: [process.execPath, command],
        credential_env: [VAULT],
        accounts: [
          {
            name: "router",
            kind: "provider",
            harness: "claude-code",
            provider: "openrouter",
            credential: REFERENCE,
            spend_cap: { daily: "20.00" },
            config_dir: configDir,
          },
        ],
      }),
    );
    const id = "20261123T080000Z-abcdef21";
    const identity = providerIdentity("openrouter", REFERENCE, null);
    earlierRecord(w, {
      id,
      account: "router",
      token: "the-token",
      configDir,
      provider: {
        provider: "openrouter",
        harness: "claude-code",
        baseUrl: null,
        identity,
      },
    });
    writeFileSync(join(w.dir, "drive-env"), "");
    writeFileSync(join(w.dir, "drive-echo-key"), "");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `--config=${BUNFIG}`,
        RUN_TS,
        id,
        "the-token",
      ],
      {
        cwd: w.repo,
        env: { ...w.env, [VAULT]: "vault-session-fixture" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ exitCode, stdout, stderr }, 0);
    expect(exitWritten(w, id)).toBe(true);
    const [run] = driveRuns(w);
    expect(run?.anthropicKey).toBe(SENTINEL);
    expect(run?.configDir).toBe(configDir);
    const stage = JSON.parse(
      readFileSync(join(w.dir, "drive-env.json"), "utf8"),
    ) as Record<string, string>;
    expect(stage.JIG_PROVIDER_CREDENTIAL).toBeUndefined();
    expect(stage[VAULT]).toBeUndefined();
    expect(stage.JIG_PROVIDER_IDENTITY).toBe(identity);
    expect(stage.JIG_SECRET_VARIABLES).toBe("ANTHROPIC_API_KEY");
    const holding = files(dispatchState(w)).filter(
      (path) =>
        statSync(path).size > 0 &&
        readFileSync(path).includes(Buffer.from(SENTINEL)),
    );
    expect(holding).toEqual([]);
  },
  60_000,
);
