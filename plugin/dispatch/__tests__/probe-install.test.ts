/**
 * The change probe's timer: its job runs `dispatch probe --apply` every
 * minute from a launcher copy of its own, beside the tick's; `jig upgrade`
 * refreshes it as a companion of the dispatcher's job, and leaves it out
 * where it is not installed. It carries the tick's Orca command
 * configuration, and an upgrade keeps what the installed job holds.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { WAKE_ATTEMPTS, WAKE_SPACING_MS } from "../../shared/wake.ts";
import { jobFiles, launcherDirectory } from "../../runtime/scheduler.ts";
import { dispatchJobSpec, probeJobSpec } from "../install.ts";

describe("the change probe's job", () => {
  it("runs dispatch probe --apply every minute, from its own launcher copy", () => {
    const probe = probeJobSpec();
    const tick = dispatchJobSpec(5);
    expect(probe.args).toEqual(["dispatch", "probe", "--apply"]);
    expect([probe.name, probe.label]).toEqual([
      "jig-dispatch-probe",
      "dev.jig.dispatch-probe",
    ]);
    expect(launcherDirectory(probe)).toBe(
      join(launcherDirectory(tick), "..", "probe", "launcher"),
    );
    expect(probe.deadlineSec).toBe(
      WAKE_ATTEMPTS * ((tick.deadlineSec ?? 0) + WAKE_SPACING_MS / 1000),
    );
    const job = {
      command: ["bun", "launcher.ts", "--", ...probe.args],
      env: {},
      spec: probe,
    };
    expect(jobFiles("systemd", job)["jig-dispatch-probe.timer"]).toContain(
      "OnUnitActiveSec=1min",
    );
    expect(jobFiles("launchd", job)["dev.jig.dispatch-probe.plist"]).toContain(
      "<key>StartInterval</key><integer>60</integer>",
    );
    expect(jobFiles("cron", job).crontab).toMatch(
      /^\*\/1 \* \* \* \* .* # jig-dispatch-probe\n$/,
    );
  });

  it("carries the Orca command configuration the tick's job does", () => {
    const env = {
      ORCA_CLI_COMMAND: " /opt/orca/bin/orca ",
      ORCA_CLI_BIN_DIR: "/opt/orca/bin",
    };
    const probe = probeJobSpec(null, env);
    expect(probe.env).toEqual({
      ORCA_CLI_COMMAND: "/opt/orca/bin/orca",
      ORCA_CLI_BIN_DIR: "/opt/orca/bin",
    });
    expect(probe.env).toEqual(dispatchJobSpec(5, null, env).env ?? {});
    expect(probeJobSpec(null, {}).env).toEqual({});
  });
});

describe("jig upgrade's refresh", () => {
  /**
   * The refresh over the dispatcher, on a systemd that holds the jobs
   * `installed` names, each with `env` beyond its home, in a home of its own
   * and an environment without Orca's command configuration.
   */
  function refresh(
    installed: string[],
    env: Record<string, string> = {},
  ): {
    results: { target: string; outcome: string; detail: string }[];
    rewritten: [string, string, string][];
    home: string;
  } {
    const home = mkdtempSync(join(tmpdir(), "probe-refresh-"));
    try {
      const scheduler = resolve(import.meta.dir, "../../runtime/scheduler.ts");
      const source = [
        'import { mock } from "bun:test";',
        `const scheduler = await import(${JSON.stringify(scheduler)});`,
        `const installed = ${JSON.stringify(installed)};`,
        `const env = ${JSON.stringify(env)};`,
        "const rewritten = [];",
        `mock.module(${JSON.stringify(scheduler)}, () => ({`,
        "  ...scheduler,",
        '  detectScheduler: () => ({ ok: true, value: "systemd" }),',
        "  snapshotScheduler: async (_, spec) => ({ ok: true, value: {",
        '    scheduler: "systemd", spec, enabled: true, active: false, launcher: {},',
        "    files: installed.includes(spec.name)",
        '      ? scheduler.jobFiles("systemd", { command: [...scheduler.launcherCommand(scheduler.launcherDirectory(spec), {}, "/bun"), ...spec.args], env: { HOME: process.env.HOME, ...env }, spec: { ...spec, schedule: { everyMinutes: 7 } } })',
        '      : { [spec.name + ".service"]: null, [spec.name + ".timer"]: null },',
        "  } }),",
        "  rewriteJob: async (snapshot, files) => { rewritten.push([snapshot.spec.name, files[snapshot.spec.name + '.timer'], files[snapshot.spec.name + '.service']]); return { ok: true, value: undefined }; },",
        "}));",
        `const { refreshInstalled } = await import(${JSON.stringify(resolve(import.meta.dir, "../../runtime/refresh.ts"))});`,
        `const { dispatchComponent } = await import(${JSON.stringify(resolve(import.meta.dir, "../component.ts"))});`,
        "const results = await refreshInstalled([dispatchComponent]);",
        "console.log(JSON.stringify({ results, rewritten }));",
      ].join("\n");
      const { ORCA_CLI_COMMAND, ORCA_CLI_BIN_DIR, ...outer } = process.env;
      const r = Bun.spawnSync([process.execPath, "-e", source], {
        env: {
          ...outer,
          HOME: home,
          USERPROFILE: home,
          JIG_HOME: join(home, ".jig"),
        },
        timeout: 30_000,
      });
      expectSpawnExit(r, 0);
      return { ...JSON.parse(r.stdout.toString()), home };
    } catch (error) {
      rmSync(home, { recursive: true, force: true });
      throw error;
    }
  }

  it("refreshes the probe's job beside the tick's, keeping its schedule", () => {
    const { results, rewritten, home } = refresh([
      "jig-dispatch",
      "jig-dispatch-probe",
    ]);
    try {
      expect(results.map((r) => [r.target, r.outcome])).toEqual([
        ["jig-dispatch", "refreshed"],
        ["jig-dispatch-probe", "refreshed"],
        ["jig command", "skipped"],
      ]);
      expect(rewritten.map(([name]) => name)).toEqual([
        "jig-dispatch",
        "jig-dispatch-probe",
      ]);
      expect(rewritten[1]?.[1]).toContain("OnUnitActiveSec=7min");
      expect(
        existsSync(
          join(
            home,
            ".local",
            "state",
            "jig",
            "dispatch",
            "probe",
            "launcher",
            "launcher.ts",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the Orca command configuration the installed probe's job carries", () => {
    const { results, rewritten, home } = refresh(
      ["jig-dispatch", "jig-dispatch-probe"],
      {
        ORCA_CLI_COMMAND: "/opt/orca/bin/orca",
        ORCA_CLI_BIN_DIR: "/opt/orca/bin",
      },
    );
    try {
      expect(results.map((r) => [r.target, r.outcome])).toContainEqual([
        "jig-dispatch-probe",
        "refreshed",
      ]);
      const service = rewritten.find(([name]) => name === "jig-dispatch-probe");
      expect(service?.[2]).toContain(
        'Environment="ORCA_CLI_COMMAND=/opt/orca/bin/orca"',
      );
      expect(service?.[2]).toContain(
        'Environment="ORCA_CLI_BIN_DIR=/opt/orca/bin"',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves the probe's job out where only the tick's is installed", () => {
    const { results, home } = refresh(["jig-dispatch"]);
    try {
      expect(
        results.map((r) => [r.target, r.outcome, r.detail]),
      ).toContainEqual(["jig-dispatch-probe", "skipped", "not installed"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
