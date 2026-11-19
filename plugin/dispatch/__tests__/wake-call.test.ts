/**
 * The wake preserves installed context and budgets a fallback from the
 * machine file. A systemd job is run as systemd runs it, its drop-ins
 * applied: a drop-in's credential wrapper is what the woken tick runs, and a
 * drop-in the waiter cannot reproduce leaves the tick unstarted.
 */
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { tickCall } from "../lib/wake-tick.ts";

function call(
  files: Record<string, string | null>,
  launcher: Record<string, string | null> = {},
  dropIns: Array<{ path: string; text: string }> = [],
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
      'detectScheduler: () => ({ ok: true, value: "systemd" }),',
      "snapshotScheduler: async (_, spec) => ({ ok: true, value: { scheduler: 'systemd', spec, files: " +
        JSON.stringify(files) +
        ", launcher: Object.fromEntries(Object.entries(" +
        JSON.stringify(launcher) +
        ").map(([name, text]) => [join(scheduler.launcherDirectory(spec), name), text])) } }),",
      "}));",
      "const dropIns = await import(" +
        JSON.stringify(
          resolve(import.meta.dir, "../../runtime/systemd-dropins.ts"),
        ) +
        ");",
      "mock.module(" +
        JSON.stringify(
          resolve(import.meta.dir, "../../runtime/systemd-dropins.ts"),
        ) +
        ", () => ({",
      "...dropIns,",
      "readDropIns: async () => ({ ok: true, value: " +
        JSON.stringify(dropIns) +
        " }),",
      'userSpecifiers: (unit) => ({ home: "/home/someone", user: "someone", uid: "1000", unit }),',
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

const UNIT =
  '[Unit]\nDescription=Dispatch\n[Service]\nExecStart="/bun" "/launcher/launcher.ts" "--" "dispatch" "--apply"\nEnvironment="JIG_LAUNCHER_DEADLINE_SEC=600"\n';
const TIMER = "[Timer]\nOnUnitActiveSec=5min\n";
const LAUNCHER = { "launcher.ts": "launcher", "bunfig.toml": "preload = []" };
const conf = (text: string) => ({
  path: "/home/someone/.config/systemd/user/jig-dispatch.service.d/secrets.conf",
  text,
});

it("runs the command a drop-in puts in place of the timer's, with the tick's arguments", () => {
  const result = call(
    { "jig-dispatch.service": UNIT, "jig-dispatch.timer": TIMER },
    LAUNCHER,
    [
      conf(
        "[Service]\nExecStart=\nExecStart=%h/bin/with-op --set jig-dispatch -- %h/.local/bin/jig dispatch --apply\nEnvironment=EXTRA=1\n",
      ),
    ],
  );
  expect(result).toMatchObject({ ok: true });
  if (result.ok) {
    expect(result.value.argv).toEqual([
      "/home/someone/bin/with-op",
      "--set",
      "jig-dispatch",
      "--",
      "/home/someone/.local/bin/jig",
      "dispatch",
      "--apply",
      "--repo",
      "/repo",
    ]);
    expect(result.value.env).toMatchObject({
      EXTRA: "1",
      JIG_LAUNCHER_DEADLINE_SEC: "600",
      JIG_LAUNCHER_ROLE: "wake",
    });
    expect(result.value.timeoutSec).toBe(660);
  }
});

it.each([
  [
    "it cannot reproduce",
    "[Service]\nEnvironmentFile=/etc/dispatch.env\n",
    "EnvironmentFile=",
  ],
  [
    "whose command does not end with the job's arguments",
    "[Service]\nExecStart=\nExecStart=/bin/with-op /home/someone/.local/bin/jig dispatch\n",
    "does not end with the job's arguments",
  ],
])(
  "starts no tick for a drop-in %s, and leaves the request for the timer",
  (_, text, reason) => {
    const result = call(
      { "jig-dispatch.service": UNIT, "jig-dispatch.timer": TIMER },
      LAUNCHER,
      [conf(text)],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toContain(reason);
      expect(result.failure.reason).toContain("left for the timer's next tick");
    }
  },
);
