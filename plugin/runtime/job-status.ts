/**
 * Whether a component's job is installed, on which scheduler and where, its
 * schedule and its next run: what `jig status` shows for each component. It
 * is read from what the scheduler holds, never from what an install would
 * write now, so a job installed before a configuration change shows the
 * schedule it actually has.
 */
import { isoOf, parseMs } from "../shared/time.ts";
import type { ComponentStatus, LastRun } from "./component.ts";
import type { JobSpec } from "./job-spec.ts";
import {
  detectScheduler,
  type Scheduler,
  type SchedulerSnapshot,
  snapshotScheduler,
} from "./scheduler.ts";

type Schedule = JobSpec["schedule"];

/** The installed job's text that holds its schedule, and where it is; null when absent. */
function installedJob(
  snapshot: SchedulerSnapshot,
): { text: string; where: string; active: boolean } | null {
  const { spec } = snapshot;
  if (snapshot.scheduler === "cron") {
    const line = (snapshot.files.crontab ?? "")
      .split("\n")
      .find((entry) => entry.endsWith(` # ${spec.name}`));
    return line === undefined
      ? null
      : { text: line, where: `crontab: # ${spec.name}`, active: true };
  }
  const suffix =
    snapshot.scheduler === "launchd"
      ? `${spec.label}.plist`
      : `${spec.name}.timer`;
  const entry = Object.entries(snapshot.files).find(
    ([path, text]) => path.endsWith(suffix) && text !== null,
  );
  if (entry === undefined) return null;
  const [path, text] = entry;
  const states = [
    ...(snapshot.enabled ? [] : ["not enabled"]),
    ...(snapshot.active ? [] : ["not active"]),
  ];
  return {
    text: text as string,
    where: `${snapshot.scheduler}: ${path}${states.length ? ` (${states.join(", ")})` : ""}`,
    active: snapshot.active,
  };
}

/** The schedule the scheduler's own text states, in the forms `jobFiles` writes. */
export function installedSchedule(
  scheduler: Scheduler,
  text: string,
): Schedule | null {
  const number = (pattern: RegExp) => {
    const match = pattern.exec(text);
    return match ? Number(match[1]) : null;
  };
  const daily =
    scheduler === "systemd"
      ? number(/^OnCalendar=\*-\*-\* (\d{2}):00:00$/m)
      : scheduler === "launchd"
        ? number(/<key>Hour<\/key><integer>(\d+)<\/integer>/)
        : number(/^0 (\d+) \* \* \* /);
  if (daily !== null) return { hour: daily };
  if (scheduler === "systemd") {
    const afterExit = number(/^OnUnitInactiveSec=(\d+)min$/m);
    if (afterExit !== null) return { everyMinutes: afterExit, afterExit: true };
  }
  const minutes = interval(scheduler, number);
  return minutes === null ? null : { everyMinutes: minutes };
}

/** An interval job's minutes, from the systemd timer, the launchd job or the crontab line. */
function interval(
  scheduler: Scheduler,
  number: (pattern: RegExp) => number | null,
): number | null {
  if (scheduler === "systemd") return number(/^OnUnitActiveSec=(\d+)min$/m);
  if (scheduler === "launchd") {
    const seconds = number(
      /<key>StartInterval<\/key><integer>(\d+)<\/integer>/,
    );
    return seconds === null ? null : seconds / 60;
  }
  const minutes = number(/^\*\/(\d+) \* \* \* \* /);
  if (minutes !== null) return minutes;
  const hours = number(/^0 \*\/(\d+) \* \* \* /);
  return hours === null ? null : hours * 60;
}

export function describeSchedule(schedule: Schedule): string {
  return "hour" in schedule
    ? `daily at ${String(schedule.hour).padStart(2, "0")}:00`
    : `every ${schedule.everyMinutes} minute${schedule.everyMinutes === 1 ? "" : "s"}${schedule.afterExit ? " after exit" : ""}`;
}

/**
 * When a daily job runs next: its hour today, local time, or tomorrow once
 * that has passed. An interval's next run depends on when the scheduler last
 * started it, so it is not told.
 */
export function nextRun(
  schedule: Schedule,
  now: Temporal.Instant,
): Temporal.Instant | null {
  if (!("hour" in schedule)) return null;
  const timeZone = Temporal.Now.timeZoneId();
  const plainTime = new Temporal.PlainTime(schedule.hour);
  // An hour the clocks skipped runs at the first moment after it.
  const at = (date: Temporal.PlainDate) =>
    date.toZonedDateTime({ timeZone, plainTime }).toInstant();
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
  const next = at(today);
  return Temporal.Instant.compare(next, now) > 0
    ? next
    : at(today.add({ days: 1 }));
}

/**
 * The status of a component whose work runs as the job `spec` names.
 * `absent` says why a job that is not installed is not, when the component
 * knows more than that it is missing.
 */
export async function scheduledStatus(
  component: string,
  spec: JobSpec,
  lastRun: LastRun | null,
  absent?: string,
  now = Temporal.Now.instant(),
): Promise<ComponentStatus> {
  const missing = (detail: string): ComponentStatus => ({
    component,
    installed: false,
    detail,
    schedule: null,
    nextRun: null,
    lastRun,
  });
  const detected = detectScheduler();
  if (!detected.ok) return missing(detected.failure.reason);
  const scheduler = detected.value;
  const snapshot = await snapshotScheduler(scheduler, spec);
  if (!snapshot.ok) {
    // One component's unreadable scheduler must not hide the others' status.
    const message = `scheduler state unreadable: ${snapshot.failure.reason}`;
    return { ...missing(message), error: message };
  }
  const job = installedJob(snapshot.value);
  if (job === null) return missing(absent ?? "no job installed");
  const schedule = installedSchedule(scheduler, job.text);
  return {
    component,
    installed: true,
    detail: job.where,
    schedule: schedule === null ? null : describeSchedule(schedule),
    nextRun:
      schedule === null || !job.active ? null : nextIso(nextRun(schedule, now)),
    lastRun,
  };
}

function nextIso(next: Temporal.Instant | null): string | null {
  return next === null ? null : isoOf(next);
}

/** `iso` as local time to the minute (`2026-11-02 04:00`); a string that is no time, as it is. */
function localMinute(iso: string): string {
  const ms = parseMs(iso);
  if (!Number.isFinite(ms)) return iso;
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" })
    .replace("T", " ");
}

/** `jig status` for people: each component's job, schedule and last run. */
export function formatStatus(status: ComponentStatus): string {
  const lines = [
    `${status.component}: ${status.error !== undefined ? "unknown" : status.installed ? "installed" : "not installed"} (${status.detail})`,
  ];
  if (status.schedule !== null)
    lines.push(
      `  schedule: ${status.schedule}${status.nextRun === null ? "" : `, next run ${localMinute(status.nextRun)}`}`,
    );
  const run = status.lastRun;
  lines.push(
    run === null
      ? "  last run: none"
      : run.unread !== undefined
        ? `  last run: unknown, the newest ${run.unread} receipts hold no tick that ran (${run.path})`
        : `  last run: ${run.runId}, started ${localMinute(run.startedAt)}, ${run.completed ? `exit ${run.exitStatus}` : "incomplete"} (${run.path})`,
  );
  return lines.join("\n");
}
