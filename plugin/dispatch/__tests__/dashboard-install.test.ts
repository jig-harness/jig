import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { installedSchedule } from "../../runtime/job-status.ts";

const modulePath = resolve(import.meta.dir, "../dashboard-install.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** An isolated user manager; commands mutate its own state, never the host's. */
function fixture(manager: "systemd" | "cron" = "systemd") {
  const root = mkdtempSync(join(tmpdir(), "dashboard-install-"));
  roots.push(root);
  const home = join(root, "home"),
    bin = join(root, "bin"),
    runtime = join(root, "run");
  const units = join(home, ".config/systemd/user"),
    plugin = join(root, "plugin");
  const jigHome = join(home, ".jig"),
    calls = join(root, "calls"),
    cron = join(root, "crontab");
  const enabled = join(root, "enabled"),
    active = join(root, "active"),
    fail = join(root, "fail-enable");
  for (const path of [home, bin, runtime, units, plugin, jigHome])
    mkdirSync(path, { recursive: true });
  if (manager === "systemd") {
    mkdirSync(join(runtime, "systemd"));
    writeFileSync(join(runtime, "systemd/private"), "");
  }
  writeFileSync(join(plugin, "jig.ts"), "// installed entry\n");
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("fixture"),
  });
  const port = reservation.port;
  reservation.stop(true);
  const machinePath = join(jigHome, "dispatch.yaml");
  writeFileSync(machinePath, `dashboard:\n  listen: 127.0.0.1:${port}\n`);
  writeFileSync(
    cron,
    "*/5 * * * * dispatcher # jig-dispatch\n* * * * * probe # jig-dispatch-probe\n",
  );
  for (const name of [
    "jig-dispatch.timer",
    "jig-dispatch.service",
    "jig-dispatch-probe.timer",
  ])
    writeFileSync(join(units, name), `preserved ${name}\n`);
  writeFakeProgram(
    join(bin, "claude"),
    `#!/usr/bin/env bun\nconsole.log(JSON.stringify([{id:"jig@jig",scope:"user",installPath:${JSON.stringify(plugin)}}]));\n`,
  );
  writeFakeProgram(
    join(bin, "loginctl"),
    '#!/usr/bin/env bun\nconsole.log(process.env.TEST_LINGER ?? "yes");\n',
  );
  writeFakeProgram(
    join(bin, "systemctl"),
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+"\\n");
if(args[1] === "show") console.log("LoadState=" + (existsSync(${JSON.stringify(join(units, "jig-dispatch-dashboard.timer"))}) ? "loaded" : "not-found") + "\\nUnitFileState=" + (existsSync(${JSON.stringify(enabled)}) ? "enabled" : "disabled") + "\\nActiveState=" + (existsSync(${JSON.stringify(active)}) ? "active" : "inactive"));
if(args[1] === "enable") {
  if(existsSync(${JSON.stringify(fail)})) { rmSync(${JSON.stringify(fail)}); console.error("injected enable failure"); process.exit(1); }
  writeFileSync(${JSON.stringify(enabled)}, ""); if(args.includes("--now")) writeFileSync(${JSON.stringify(active)}, "");
}
if(args[1] === "disable") { rmSync(${JSON.stringify(enabled)}, {force:true}); rmSync(${JSON.stringify(active)}, {force:true}); }
if(args[1] === "start") writeFileSync(${JSON.stringify(active)}, "");
`,
  );
  writeFakeProgram(
    join(bin, "crontab"),
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
if(process.argv[2] === "-l") process.stdout.write(readFileSync(${JSON.stringify(cron)}, "utf8"));
else writeFileSync(${JSON.stringify(cron)}, await Bun.stdin.text());
`,
  );
  const driver = join(root, "driver.ts");
  writeFileSync(
    driver,
    `if(process.env.TEST_PLATFORM) Object.defineProperty(process, "platform", {value:process.env.TEST_PLATFORM});
const { dashboardInstall } = await import(${JSON.stringify(modulePath)});
process.exit(await dashboardInstall(process.argv[2] === "apply", process.argv[3] === "remove", ${JSON.stringify(join(plugin, "jig.ts"))}));\n`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("JIG_") &&
        !key.startsWith("LOCK_") &&
        !key.startsWith("DRIVE_PR_"),
    ),
  );
  const run = (
    confirm = true,
    remove = false,
    extra: Record<string, string> = {},
  ) =>
    Bun.spawnSync(
      [
        process.execPath,
        driver,
        confirm ? "apply" : "preview",
        remove ? "remove" : "install",
      ],
      {
        cwd: root,
        env: {
          ...environment,
          HOME: home,
          USERPROFILE: home,
          JIG_HOME: jigHome,
          XDG_RUNTIME_DIR: runtime,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          ...extra,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30000,
      },
    );
  return {
    root,
    home,
    units,
    calls,
    cron,
    enabled,
    active,
    fail,
    machinePath,
    run,
    reader: join(home, ".local/state/jig/dispatch/dashboard"),
  };
}

describe.skipIf(process.platform !== "linux")(
  "dashboard availability installation on Linux",
  () => {
    test("preview writes no service or generation", () => {
      const f = fixture();
      const result = f.run(false);
      expectSpawnExit(result, 0);
      expect(result.stdout.toString()).toContain("Preview only");
      expect(existsSync(join(f.units, "jig-dispatch-dashboard.timer"))).toBe(
        false,
      );
      expect(existsSync(join(f.reader, "enabled"))).toBe(false);
      expect(existsSync(f.calls)).toBe(false);
    });

    test("repeat installation keeps one timer and generation; uninstall preserves dispatch jobs", () => {
      const f = fixture();
      expectSpawnExit(f.run(), 0);
      const generation = readFileSync(join(f.reader, "enabled"), "utf8");
      const service = readFileSync(
        join(f.units, "jig-dispatch-dashboard.service"),
        "utf8",
      );
      const timer = readFileSync(
        join(f.units, "jig-dispatch-dashboard.timer"),
        "utf8",
      );
      expect(timer).toContain("OnUnitInactiveSec=1min");
      expect(installedSchedule("systemd", timer)).toEqual({
        everyMinutes: 1,
        afterExit: true,
      });
      expect(service).toContain('"dispatch" "dashboard" "--scheduled"');
      expect(service).not.toContain("token=");
      expectSpawnExit(f.run(), 0);
      expect(readFileSync(join(f.reader, "enabled"), "utf8")).toBe(generation);
      expect(
        readFileSync(join(f.units, "jig-dispatch-dashboard.service"), "utf8"),
      ).toBe(service);
      expectSpawnExit(f.run(true, true), 0);
      expect(existsSync(join(f.reader, "enabled"))).toBe(false);
      expect(existsSync(join(f.units, "jig-dispatch-dashboard.timer"))).toBe(
        false,
      );
      expect(existsSync(join(f.reader, "launcher"))).toBe(false);
      for (const name of [
        "jig-dispatch.timer",
        "jig-dispatch.service",
        "jig-dispatch-probe.timer",
      ])
        expect(readFileSync(join(f.units, name), "utf8")).toBe(
          `preserved ${name}\n`,
        );
      const commands = readFileSync(f.calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(
        commands.every(
          (args) =>
            !args.some((arg) =>
              /^(jig-dispatch|jig-dispatch-probe)\.(timer|service)$/.test(arg),
            ),
        ),
      ).toBe(true);
    });

    test("missing lingering refuses before writing; uninstall still works without lingering", () => {
      const f = fixture();
      const result = f.run(true, false, { TEST_LINGER: "no" });
      expectSpawnExit(result, 1);
      expect(result.stderr.toString()).toContain("enable-linger");
      expect(existsSync(join(f.reader, "enabled"))).toBe(false);
      expect(existsSync(f.calls)).toBe(false);
      expectSpawnExit(f.run(), 0);
      expectSpawnExit(f.run(true, true, { TEST_LINGER: "no" }), 0);
    });

    test("cron replaces only its own marker on reinstall and removal", () => {
      const f = fixture("cron");
      const original = readFileSync(f.cron, "utf8");
      expectSpawnExit(f.run(), 0);
      expectSpawnExit(f.run(), 0);
      const entries = readFileSync(f.cron, "utf8");
      expect(
        entries
          .split("\n")
          .filter((line) => line.endsWith("# jig-dispatch-dashboard")),
      ).toHaveLength(1);
      expect(entries).toContain(original);
      expectSpawnExit(f.run(true, true), 0);
      expect(readFileSync(f.cron, "utf8")).toBe(original);
    });

    test("GUI launchd is refused rather than promising availability after logout", () => {
      const f = fixture();
      const result = f.run(true, false, { TEST_PLATFORM: "darwin" });
      expectSpawnExit(result, 1);
      expect(result.stderr.toString()).toContain("LaunchAgents stop at logout");
      expect(existsSync(join(f.reader, "enabled"))).toBe(false);
    });

    test("an occupied listener refuses before installing a retry loop", () => {
      const f = fixture();
      const occupied = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("another reader"),
      });
      try {
        writeFileSync(
          f.machinePath,
          `dashboard:\n  listen: 127.0.0.1:${occupied.port}\n`,
        );
        const result = f.run();
        expectSpawnExit(result, 1);
        expect(result.stderr.toString()).toContain(
          "dashboard address is unavailable",
        );
        expect(existsSync(join(f.reader, "enabled"))).toBe(false);
        expect(existsSync(join(f.units, "jig-dispatch-dashboard.timer"))).toBe(
          false,
        );
        expect(existsSync(f.calls)).toBe(false);
      } finally {
        occupied.stop(true);
      }
    });

    test("failed replacement restores previous unit files and enabled state", () => {
      const f = fixture();
      expectSpawnExit(f.run(), 0);
      const timer = join(f.units, "jig-dispatch-dashboard.timer");
      writeFileSync(timer, "previous timer\n");
      writeFileSync(f.fail, "");
      const result = f.run();
      expectSpawnExit(result, 1);
      expect(result.stderr.toString()).toContain("injected enable failure");
      expect(readFileSync(timer, "utf8")).toBe("previous timer\n");
      expect(existsSync(f.enabled)).toBe(true);
      expect(existsSync(f.active)).toBe(true);
    });
  },
);
