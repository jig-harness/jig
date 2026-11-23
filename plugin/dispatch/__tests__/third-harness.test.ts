/**
 * A third agent harness, registered only in this test, is launched by the
 * dispatcher's and the drive's own call sites with none of them changed
 * (ADR-0026): the pass commands, the launch environment, the account's
 * admission and identity, the session id and the resume line all come from
 * the harness the registry holds under the account's vendor.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { registerHarness } from "../../shared/agent-harness/index.ts";
import {
  FAKE_CREDENTIAL,
  FAKE_DIRECTORY_VARIABLE,
  FAKE_MARKER,
  FAKE_NAME,
  FAKE_PROGRAM,
  fakeHarness,
} from "../../shared/__tests__/fake-harness.ts";
import { resolveAccountIdentity } from "../../skills/drive-pr/scripts/lib/identity.ts";
import {
  isPassVendor,
  onlyDeadlineBounds,
  passCommand,
  passPrompt,
} from "../../skills/drive-pr/scripts/lib/pass-command.ts";
import { sessionVendor } from "../../skills/drive-pr/scripts/lib/arm.ts";
import { admittedVendor, passEnvironment } from "../lib/accounts.ts";
import { resumeLine } from "../lib/attach-resume.ts";
import type { LaunchRecord } from "../lib/launches.ts";
import {
  processEnvironment,
  processSettings,
} from "../lib/runtime/process-environment.ts";
import { effectivePass } from "../../skills/drive-pr/scripts/lib/pass-model.ts";
import { registerWallReader } from "../../skills/drive-pr/scripts/lib/quota/index.ts";
import {
  followupPassArgv,
  pickupPassArgv,
  sessionArgv,
  sessionIdFor,
  stewardPassArgv,
} from "../lib/session.ts";

let unregister: (() => void) | null = null;
beforeEach(() => {
  unregister = registerHarness(fakeHarness);
});
afterEach(() => unregister?.());

const record = {
  id: "20261123T000000Z-00000000",
  token: "0".repeat(32),
  action: "pickup",
  repo: "owner/repo",
  repoPath: "/repos/repo",
  pr: 12,
  item: "#1",
  marker: 41,
  command: "/jig:followup",
  vendor: FAKE_NAME,
  configDir: "/accounts/fake-one",
  model: "fake-large",
  effort: "high",
  sessionId: null,
  workspace: null,
} as unknown as LaunchRecord;

/** Start `argv` in the environment a launch on the fake's account gets, and return what it printed. */
function launch(argv: readonly string[]): string {
  const env = passEnvironment(
    { ...process.env, [FAKE_CREDENTIAL]: "secret", [FAKE_MARKER]: "1" },
    { vendor: FAKE_NAME, configDir: "/accounts/fake-one" },
  );
  const done = Bun.spawnSync([...argv], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(done, 0, argv.slice(0, 3).join(" "));
  return done.stdout.toString().trim();
}

describe("a harness registered only here", () => {
  it("is admitted as a vendor with a documented pass command", () => {
    expect(isPassVendor(FAKE_NAME)).toBe(true);
    expect(onlyDeadlineBounds(FAKE_NAME)).toBe(false);
    expect(
      admittedVendor({
        name: "fake-one",
        vendor: FAKE_NAME,
        configDir: "/accounts/fake-one",
        identity: "fake@fake-one",
        maxPerAccount: 1,
      }),
    ).toBe(FAKE_NAME);
  });

  it("runs the drive's pass, its prompt in the harness's own skill form", () => {
    const argv = passCommand(FAKE_NAME, 7);
    expect(argv[0]).toBe(FAKE_PROGRAM);
    expect(passPrompt(FAKE_NAME, 7)).toStartWith(
      "Fake skill run: /jig:drive-pr --bots-only 7",
    );
    expect(launch(argv)).toBe(passPrompt(FAKE_NAME, 7));
  });

  it("runs the dispatcher's pickup, follow-up and steward passes on the record's route", () => {
    for (const argv of [
      pickupPassArgv(record, ["--host-word"]),
      followupPassArgv({ ...record, action: "followup" }, ["--host-word"]),
      stewardPassArgv({ ...record, action: "steward" }, ["--host-word"]),
    ]) {
      expect(argv[0]).toBe(FAKE_PROGRAM);
      expect(argv).toContain("--host-word");
      expect(argv.at(-1)).toStartWith("Fake skill run: /jig:");
      expect(launch(argv)).toStartWith("Fake skill run: /jig:");
    }
    expect(stewardPassArgv({ ...record, action: "steward" }, [])).toContain(
      "--fake-model",
    );
    expect(sessionArgv(record).slice(0, 3)).toEqual([
      FAKE_PROGRAM,
      "--fake-model",
      "fake-large",
    ]);
  });

  it("gets its directory, and none of its credentials or session markers, in a launch's environment", () => {
    const base = {
      [FAKE_CREDENTIAL]: "secret",
      [FAKE_MARKER]: "1",
      HOME: "/home/someone",
    };
    const account = { vendor: FAKE_NAME, configDir: "/accounts/fake-one" };
    const env = passEnvironment(base, account);
    expect(env[FAKE_DIRECTORY_VARIABLE]).toBe("/accounts/fake-one");
    expect(env[FAKE_CREDENTIAL]).toBeUndefined();
    expect(env[FAKE_MARKER]).toBeUndefined();
    const processEnv = processEnvironment(base, { envKeep: [] }, account);
    expect(processEnv[FAKE_DIRECTORY_VARIABLE]).toBe("/accounts/fake-one");
    expect(processEnv[FAKE_CREDENTIAL]).toBeUndefined();
  });

  it("reads its account, mints its session id and resumes its session", () => {
    expect(resolveAccountIdentity([FAKE_PROGRAM, "-e", "x"])).toMatchObject({
      vendor: FAKE_NAME,
      provenance: FAKE_DIRECTORY_VARIABLE,
    });
    expect(sessionIdFor(FAKE_NAME)).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionVendor({ CLAUDECODE: "1" })).not.toBe(FAKE_NAME);
    expect(
      resumeLine({
        record: { ...record, sessionId: "s-1" },
        sessions: [],
        exit: null,
      }),
    ).toBe(
      `cd /repos/repo && ${FAKE_DIRECTORY_VARIABLE}=/accounts/fake-one ${FAKE_PROGRAM} --fake-resume s-1`,
    );
  });

  it("is gone once its registration is undone", () => {
    unregister?.();
    expect(isPassVendor(FAKE_NAME)).toBe(false);
    expect(() => passCommand(FAKE_NAME, 7)).toThrow();
  });

  it("refuses its credentials and session markers in env_keep, in any case", () => {
    for (const name of [
      FAKE_CREDENTIAL,
      FAKE_CREDENTIAL.toLowerCase(),
      FAKE_MARKER,
    ])
      expect(processSettings({ env_keep: [name] })).toMatchObject({
        ok: false,
      });
    expect(
      processSettings({ env_keep: ["SOME_OTHER_VARIABLE"] }),
    ).toMatchObject({ ok: true });
  });

  it("takes --pass-model in its own form", () => {
    const pass = effectivePass([FAKE_PROGRAM, "-p", "x"], "fake-large");
    expect(pass.argv).toContain("--fake-model");
    expect(pass.argv).toContain(pass.model as string);
  });

  it("registers a wall reader and removes it again", () => {
    const adapter = { vendor: "fake-reader" } as never;
    const remove = registerWallReader("fake-reader", adapter);
    expect(typeof remove).toBe("function");
    remove();
  });
});
