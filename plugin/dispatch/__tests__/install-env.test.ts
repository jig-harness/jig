/**
 * On macOS the dispatcher's install keeps the variables a person added to
 * the installed launchd job, writes the ones `--env NAME` captures from the
 * installing shell, refreshes Jig's own, and never shows a kept or captured
 * value in its preview. Each case runs in a child with a home of its own,
 * `process.platform` reading `darwin` and a fake `launchctl` on `PATH`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { parseLaunchdEnvironment } from "../../runtime/job-environment.ts";
import { jobFiles } from "../../runtime/scheduler.ts";
import { dispatchJobSpec } from "../install.ts";

function launchdEnvironment(plist: string): Record<string, string> {
  const read = parseLaunchdEnvironment(plist);
  if (!read.ok) throw new Error(read.failure.reason);
  return read.value;
}

const install = resolve(import.meta.dir, "../install.ts");
const scheduler = resolve(import.meta.dir, "../../runtime/scheduler.ts");
const environment = resolve(
  import.meta.dir,
  "../../runtime/job-environment.ts",
);
const machineConfig = resolve(import.meta.dir, "../lib/machine-config.ts");

/** What the installed job held before the install: two of Jig's variables, and two a person added. */
const INSTALLED = {
  HOME: "/old/home",
  PATH: "/old/bin",
  JIRA_TOKEN_COMMAND: "broker token --kept-secret",
  REPLACED_TOKEN: "old-secret-value",
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dispatch-install-env-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const agents = join(home, "Library", "LaunchAgents");
  const calls = join(root, "launchctl.log");
  mkdirSync(agents, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const plist = join(agents, "dev.jig.dispatch.plist");
  const installed = jobFiles("launchd", {
    command: ["/old/bun", "launcher.ts", "--", "dispatch", "--apply"],
    env: INSTALLED,
    spec: dispatchJobSpec(5, null, {}),
  })["dev.jig.dispatch.plist"] as string;
  // As a person's editor leaves it: readable by others until the install narrows it.
  writeFileSync(plist, installed, { mode: 0o644 });
  chmodSync(plist, 0o644);
  writeFakeProgram(
    join(bin, "launchctl"),
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
// launchctl print exits 113 for a service it does not know.
if (args[0] === "print") process.exit(113);
`,
  );
  const driver = join(root, "driver.ts");
  writeFileSync(
    driver,
    `Object.defineProperty(process, "platform", { value: process.env.TEST_PLATFORM ?? "darwin" });
const { installDispatch, dispatchJobSpec, probeJobSpec } = await import(${JSON.stringify(install)});
const { managedEnvironment, updateJob } = await import(${JSON.stringify(scheduler)});
const { capturedEnvironment } = await import(${JSON.stringify(environment)});
const { parseMachineConfigText } = await import(${JSON.stringify(machineConfig)});
const names = JSON.parse(process.env.TEST_ENV_NAMES ?? "[]");
const mode = process.argv[2];
try {
  if (mode === "write") {
    const captured = capturedEnvironment(names, process.env, managedEnvironment(dispatchJobSpec(5)));
    if (!captured.ok) throw new Error(captured.failure.reason);
    for (const spec of [dispatchJobSpec(5, null, process.env, captured.value), probeJobSpec(null, process.env, captured.value)]) {
      const job = await updateJob(spec);
      if (!job.ok) throw new Error(job.failure.reason);
      console.log(job.value);
    }
    process.exit(0);
  }
  const machine = parseMachineConfigText("repositories: []\\n", "dispatch.yaml");
  if (!machine.ok) throw new Error(machine.failure.reason);
  process.exit(await installDispatch(
    { intervalMs: null, confirm: mode === "confirm", uninstall: false, env: names },
    ${JSON.stringify(join(root, "jig.ts"))},
    machine.value,
  ));
} catch (error) {
  console.error(error.message);
  process.exit(error.code ?? 1);
}
`,
  );
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("JIG_") &&
        !key.startsWith("LOCK_") &&
        !key.startsWith("DRIVE_PR_") &&
        !key.startsWith("ORCA_"),
    ),
  );
  const path = `${bin}${delimiter}${process.env.PATH}`;
  const run = (
    mode: "write" | "preview" | "confirm",
    names: string[],
    extra: Record<string, string> = {},
  ) =>
    Bun.spawnSync([process.execPath, driver, mode], {
      cwd: root,
      env: {
        ...inherited,
        HOME: home,
        JIG_HOME: join(home, ".jig"),
        PATH: path,
        TEST_ENV_NAMES: JSON.stringify(names),
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    });
  return { home, agents, plist, installed, calls, path, run };
}

describe.skipIf(process.platform === "win32")(
  "the dispatcher's launchd install and its environment",
  () => {
    test("a reinstall keeps the person's variables, writes --env's and refreshes Jig's, at 0600", () => {
      const f = fixture();
      const result = f.run("write", ["REPLACED_TOKEN", "NEW_TOKEN"], {
        REPLACED_TOKEN: "new-secret-value",
        NEW_TOKEN: "captured-secret",
      });
      expectSpawnExit(result, 0);
      const env = launchdEnvironment(readFileSync(f.plist, "utf8"));
      expect(env.JIRA_TOKEN_COMMAND).toBe("broker token --kept-secret");
      expect(env.REPLACED_TOKEN).toBe("new-secret-value");
      expect(env.NEW_TOKEN).toBe("captured-secret");
      expect(env.HOME).toBe(f.home);
      expect(env.PATH).toBe(f.path);
      expect(statSync(f.plist).mode & 0o777).toBe(0o600);
      expect(readFileSync(f.calls, "utf8")).toContain("bootstrap");
      const probe = join(f.agents, "dev.jig.dispatch-probe.plist");
      const probeEnv = launchdEnvironment(readFileSync(probe, "utf8"));
      expect(probeEnv.NEW_TOKEN).toBe("captured-secret");
      expect(probeEnv.REPLACED_TOKEN).toBe("new-secret-value");
      expect(probeEnv.JIRA_TOKEN_COMMAND).toBeUndefined();
      expect(statSync(probe).mode & 0o777).toBe(0o600);
    });

    test("a first install, with no job installed, carries nothing forward", () => {
      const f = fixture();
      rmSync(f.plist);
      expectSpawnExit(f.run("write", []), 0);
      const env = launchdEnvironment(readFileSync(f.plist, "utf8"));
      expect(env.JIRA_TOKEN_COMMAND).toBeUndefined();
      expect(env.HOME).toBe(f.home);
      expect(statSync(f.plist).mode & 0o777).toBe(0o600);
    });

    test("the preview names the kept and captured variables and never shows a value", () => {
      const f = fixture();
      const result = f.run("preview", ["REPLACED_TOKEN", "NEW_TOKEN"], {
        REPLACED_TOKEN: "new-secret-value",
        NEW_TOKEN: "captured-secret",
      });
      expectSpawnExit(result, 0);
      const out = result.stdout.toString() + result.stderr.toString();
      expect(out).toContain(
        "Kept from the installed job, values shown as (hidden): JIRA_TOKEN_COMMAND",
      );
      expect(out).toContain(
        "Captured from this shell with --env, values shown as (hidden): REPLACED_TOKEN, NEW_TOKEN",
      );
      expect(out).toContain("<key>NEW_TOKEN</key><string>(hidden)</string>");
      for (const value of [
        "broker token --kept-secret",
        "old-secret-value",
        "new-secret-value",
        "captured-secret",
      ])
        expect(out).not.toContain(value);
      expect(readFileSync(f.plist, "utf8")).toBe(f.installed);
      expect(existsSync(f.calls)).toBe(false);
    });

    test.each([
      ["NAME=VALUE", ["NEW_TOKEN=captured-secret"], "never NAME=VALUE"],
      ["an unset variable", ["NOT_SET_ANYWHERE"], "unset or empty"],
      ["an empty variable", ["EMPTY_TOKEN"], "unset or empty"],
    ])(
      "--env with %s is refused before anything is written",
      (_, names, reason) => {
        const f = fixture();
        const result = f.run("confirm", names, {
          NEW_TOKEN: "captured-secret",
          EMPTY_TOKEN: "",
        });
        expectSpawnExit(result, 2);
        expect(result.stderr.toString()).toContain(reason);
        expect(result.stderr.toString()).not.toContain("captured-secret");
        expect(result.stdout.toString()).toBe("");
        expect(readFileSync(f.plist, "utf8")).toBe(f.installed);
        expect(existsSync(f.calls)).toBe(false);
      },
    );

    test("--env is refused on a scheduler other than launchd, naming the drop-in instead", () => {
      const f = fixture();
      const result = f.run("confirm", ["NEW_TOKEN"], {
        NEW_TOKEN: "captured-secret",
        TEST_PLATFORM: "linux",
      });
      expectSpawnExit(result, 2);
      expect(result.stderr.toString()).toContain(
        "--env writes into a macOS launchd job",
      );
      expect(result.stderr.toString()).toContain("drop-in");
      expect(result.stderr.toString()).not.toContain("captured-secret");
    });
  },
);
