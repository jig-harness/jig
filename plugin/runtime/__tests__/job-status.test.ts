/**
 * `jig status` reads a job's schedule back from what the scheduler holds:
 * each form `jobFiles` writes must read back as the schedule it was written
 * from, on every scheduler.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { dispatchJobSpec } from "../../dispatch/install.ts";
import { gcJobSpec } from "../../gc/job-spec.ts";
import { describeSchedule, installedSchedule, nextRun } from "../job-status.ts";
import type { JobSpec } from "../job-spec.ts";
import { jobFiles, type Scheduler } from "../scheduler.ts";

const SCHEDULERS: Scheduler[] = ["systemd", "launchd", "cron"];

/** The file of the job that holds its schedule, as the scheduler keeps it. */
function scheduleText(scheduler: Scheduler, spec: JobSpec): string {
  const files = jobFiles(scheduler, {
    command: ["bun", "launcher.ts"],
    env: {},
    spec,
  });
  return scheduler === "systemd"
    ? (files[`${spec.name}.timer`] as string)
    : scheduler === "launchd"
      ? (files[`${spec.label}.plist`] as string)
      : (files.crontab as string);
}

test.each(SCHEDULERS)(
  "each schedule the %s job is written with reads back as itself",
  (scheduler) => {
    for (const spec of [
      gcJobSpec(4),
      gcJobSpec(0),
      gcJobSpec(23),
      dispatchJobSpec(5),
      dispatchJobSpec(30),
      dispatchJobSpec(120),
    ])
      expect([
        spec.schedule,
        installedSchedule(scheduler, scheduleText(scheduler, spec)),
      ]).toEqual([spec.schedule, spec.schedule]);
  },
);

test("a job text in no form install writes has no schedule", () => {
  for (const scheduler of SCHEDULERS)
    expect(installedSchedule(scheduler, "edited by hand")).toBeNull();
});

test("a daily job runs next at its hour today, or tomorrow once it has passed", () => {
  const morning = new Date(2026, 10, 1, 3, 59);
  expect(nextRun({ hour: 4 }, morning)).toEqual(new Date(2026, 10, 1, 4, 0));
  const onTheHour = new Date(2026, 10, 1, 4, 0);
  expect(nextRun({ hour: 4 }, onTheHour)).toEqual(new Date(2026, 10, 2, 4, 0));
  expect(nextRun({ everyMinutes: 5 }, morning)).toBeNull();
});

test("schedules read in words", () => {
  expect(describeSchedule({ hour: 4 })).toBe("daily at 04:00");
  expect(describeSchedule({ everyMinutes: 1 })).toBe("every 1 minute");
  expect(describeSchedule({ everyMinutes: 5 })).toBe("every 5 minutes");
});

test("tomorrow's hour is the configured one after the clocks skipped today's", () => {
  // 2026-03-08 is the spring-forward day in New York: 02:00 does not exist,
  // so today's setHours(2) lands at 03:00, which has passed by noon.
  const script = `
    import { nextRun } from ${JSON.stringify(join(import.meta.dir, "../job-status.ts"))};
    const next = nextRun({ hour: 2 }, new Date(2026, 2, 8, 12, 0));
    console.log(JSON.stringify([next.getDate(), next.getHours()]));
  `;
  const result = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, TZ: "America/New_York" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString())).toEqual([9, 2]);
});
