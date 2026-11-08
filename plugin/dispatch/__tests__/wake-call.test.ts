/** The wake preserves installed context and budgets a fallback from the machine file. */
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { tickCall } from "../lib/wake-tick.ts";

function call(
  files: Record<string, string | null>,
  launcher: Record<string, string | null> = {},
): Awaited<ReturnType<typeof tickCall>> {
  const home = mkdtempSync(join(tmpdir(), "wake-call-"));
  try {
    const source = [
      'import { mock } from "bun:test";',
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'mkdirSync(process.env.HOME + "/.jig");',
      'writeFileSync(process.env.HOME + "/.jig/dispatch.yaml", "repositories: []\\nworkspace_timeout: 4h\\nruntime_timeout: 1m\\n");',
      "const scheduler = await import(" +
        JSON.stringify(resolve(import.meta.dir, "../../runtime/scheduler.ts")) +
        ");",
      "mock.module(" +
        JSON.stringify(resolve(import.meta.dir, "../../runtime/scheduler.ts")) +
        ", () => ({",
      "...scheduler,",
      'detectScheduler: () => "systemd",',
      "snapshotScheduler: async (_, spec) => ({ scheduler: 'systemd', spec, files: " +
        JSON.stringify(files) +
        ", launcher: Object.fromEntries(Object.entries(" +
        JSON.stringify(launcher) +
        ").map(([name, text]) => [join(scheduler.launcherDirectory(spec), name), text])) }),",
      "}));",
      "const { tickCall } = await import(" +
        JSON.stringify(resolve(import.meta.dir, "../lib/wake-tick.ts")) +
        ");",
      'console.log(JSON.stringify(await tickCall("/repo")));',
    ].join("\n");
    const result = Bun.spawnSync([process.execPath, "-e", source], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        JIG_HOME: join(home, ".jig"),
        JIG_WAKE_COMMAND: "",
      },
      timeout: 10_000,
    });
    expectSpawnExit(result, 0);
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

it("keeps a partial timer installation unstarted", () => {
  const result = call({
    "jig-dispatch.service": "[Service]\nExecStart=/broken\n",
    "jig-dispatch.timer": null,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.reason).toContain("installed timer");
});

it.each(["launcher.ts", "bunfig.toml"])(
  "keeps a timer missing %s unstarted",
  (missing) => {
    const result = call(
      {
        "jig-dispatch.service":
          '[Unit]\nDescription=Dispatch\n[Service]\nExecStart="/bun" "/launcher/launcher.ts" "--" "dispatch" "--apply"\n',
        "jig-dispatch.timer": "[Timer]\nOnUnitActiveSec=5min\n",
      },
      {
        "launcher.ts": "launcher",
        "bunfig.toml": "preload = []",
        [missing]: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toContain("installed timer");
  },
);

it("gives a timer-free tick the configured workspace and runtime budget", () => {
  const result = call({
    "jig-dispatch.service": null,
    "jig-dispatch.timer": null,
  });
  expect(result).toMatchObject({ ok: true });
  // Four launch opens and the follow-ups' two, of four hours each, eight runtime calls and a minute's grace.
  if (result.ok)
    expect(result.value.timeoutSec).toBe((4 + 2) * 4 * 3600 + 8 * 60 + 60);
});

it("runs a complete installed timer", () => {
  const result = call(
    {
      "jig-dispatch.service":
        '[Unit]\nDescription=Dispatch\n[Service]\nExecStart="/bun" "/launcher/launcher.ts" "--" "dispatch" "--apply"\n',
      "jig-dispatch.timer": "[Timer]\nOnUnitActiveSec=5min\n",
    },
    { "launcher.ts": "launcher", "bunfig.toml": "preload = []" },
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.argv).toEqual([
      "/bun",
      "/launcher/launcher.ts",
      "--",
      "dispatch",
      "--apply",
      "--repo",
      "/repo",
    ]);
});
