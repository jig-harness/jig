/**
 * An installed job read back from the scheduler's text is the job that was
 * written, on every scheduler and with every character a path or an
 * environment value may hold; so is the `jig` command's script. `jig upgrade`
 * rewrites a job from what this reads, so a value that does not survive the
 * round trip would change a job it only meant to refresh.
 */
import { expect, test } from "bun:test";
import {
  commandScriptCall,
  launcherCall,
  readInstalledJob,
  shellWords,
} from "../installed-job.ts";
import type { JobSpec } from "../job-spec.ts";
import { commandText } from "../path-command.ts";
import { type Job, jobFiles, type Scheduler } from "../scheduler.ts";

/** The `jig` command's script as `commandText` writes it. */
function written(...args: Parameters<typeof commandText>): string {
  const text = commandText(...args);
  if (!text.ok) throw new Error(text.failure.reason);
  return text.value;
}

/** Quotes, a dollar, a percent sign, a backslash, and XML's specials and an entity's text. */
const AWKWARD = `/odd path/it's $HOME 100% \\back "quoted" <&> &lt;`;

function job(schedule: JobSpec["schedule"]): Job {
  return {
    command: [
      "/usr/bin/bun",
      "--no-env-file",
      `--config=${AWKWARD}/bunfig.toml`,
      `${AWKWARD}/launcher.ts`,
      `--claude=${AWKWARD}/claude`,
      "--codex=/usr/local/bin/codex",
      "--",
      "test",
      "--timer",
    ],
    env: {
      HOME: "/home/someone",
      PATH: `/usr/bin:${AWKWARD}`,
      LOCK_TIMEOUT: "60",
    },
    spec: {
      name: "jig-test",
      label: "dev.jig.test",
      description: "Jig test job",
      timerDescription: "Jig test job's timer",
      stateRoot: "/state",
      args: ["test", "--timer"],
      schedule,
    },
  };
}

/** The snapshot `snapshotScheduler` would take of the job `files` hold. */
function snapshot(scheduler: Scheduler, files: Record<string, string>) {
  const written = job({ hour: 0 }).spec;
  return {
    scheduler,
    spec: written,
    files:
      scheduler === "cron"
        ? { crontab: `0 1 * * * other-job # someone-else\n${files.crontab}` }
        : Object.fromEntries(
            Object.entries(files).map(([name, text]) => [
              `/jobs/${name}`,
              text,
            ]),
          ),
    launcher: {},
    enabled: true,
    active: true,
  };
}

test.each([
  ["systemd", { hour: 4 }],
  ["systemd", { everyMinutes: 5 }],
  ["launchd", { hour: 4 }],
  ["launchd", { everyMinutes: 5 }],
  ["cron", { hour: 4 }],
  ["cron", { everyMinutes: 5 }],
] as [Scheduler, JobSpec["schedule"]][])(
  "a %s job reads back as written (%p)",
  (scheduler, schedule) => {
    const written = job(schedule);
    const read = readInstalledJob(
      snapshot(scheduler, jobFiles(scheduler, written)),
    );
    expect(read).toEqual({
      command: written.command,
      env: written.env,
      schedule,
      ...(scheduler === "systemd"
        ? {
            description: written.spec.description,
            timerDescription: written.spec.timerDescription,
          }
        : {}),
    });
  },
);

test("no job is read where the scheduler holds none", () => {
  expect(readInstalledJob(snapshot("cron", { crontab: "" }))).toBeNull();
  expect(
    readInstalledJob({
      ...snapshot("systemd", {}),
      files: { "/jobs/jig-test.timer": null },
    }),
  ).toBeNull();
});

test("a launcher command splits into its Bun, its agent tools and the arguments it passes on", () => {
  expect(launcherCall(job({ hour: 4 }).command)).toEqual({
    bun: "/usr/bin/bun",
    programs: { claude: `${AWKWARD}/claude`, codex: "/usr/local/bin/codex" },
    args: ["test", "--timer"],
  });
  expect(launcherCall(["/usr/bin/bun", "launcher.ts"])).toBeNull();
});

test.each(["linux", "win32"] as NodeJS.Platform[])(
  "the jig command's script reads back as written (%s)",
  (platform) => {
    const command = [
      "/usr/bin/bun",
      "--no-env-file",
      `--config=/odd path/it's 100%/bunfig.toml`,
      "/state/launcher.ts",
      "--claude=/usr/local/bin/claude",
      "--",
    ];
    expect(commandScriptCall(written(command, platform, 32400))).toEqual({
      command,
      deadlineSec: 32400,
    });
    expect(commandScriptCall(written(command, platform))).toEqual({
      command,
    });
  },
);

test("shell words undo single quoting, and a quote left open reads as none", () => {
  expect(shellWords(`'it'\\''s' 'two words'  'x'`)).toEqual([
    "it's",
    "two words",
    "x",
  ]);
  expect(shellWords("'closed' 'open")).toBeNull();
});
