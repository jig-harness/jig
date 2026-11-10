/**
 * The platform schedulers' jobs (a launchd job, a systemd user timer or a
 * crontab line), written for each component of the `jig` command from its
 * `JobSpec`. A job runs a launcher copied out of the plugin, with an explicit
 * environment, and the launcher runs the installed copy of the plugin.
 */
import { jigHome } from "../shared/config-layers.ts";
import { GcError } from "../shared/gc-error.ts";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import { run } from "../shared/proc.ts";
import { MAX_TIMEOUT_SECONDS } from "../shared/resource-lock.ts";
import { installedEntry, outsideCheckout } from "./launcher.ts";
import type { JobSpec } from "./job-spec.ts";

function cronMarker(spec: JobSpec): string {
  return `# ${spec.name}`;
}
function timerUnit(spec: JobSpec): string {
  return `${spec.name}.timer`;
}
export type Scheduler = "launchd" | "systemd" | "cron";
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function systemd(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new GcError("Scheduler values cannot contain line breaks or NUL");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}
export interface Job {
  command: string[];
  env: Record<string, string>;
  /** The job written: its names, schedule and where its logs go. */
  spec: JobSpec;
}
/** The calendar part of each scheduler's job for `schedule`. */
function launchdSchedule(schedule: JobSpec["schedule"]): string {
  return "hour" in schedule
    ? `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${schedule.hour}</integer><key>Minute</key><integer>0</integer></dict>`
    : `<key>StartInterval</key><integer>${schedule.everyMinutes * 60}</integer>`;
}
function systemdSchedule(schedule: JobSpec["schedule"]): string {
  return "hour" in schedule
    ? `OnCalendar=*-*-* ${String(schedule.hour).padStart(2, "0")}:00:00\nPersistent=true`
    : `OnActiveSec=1min\n${schedule.afterExit ? "OnUnitInactiveSec" : "OnUnitActiveSec"}=${schedule.everyMinutes}min`;
}
function cronSchedule(schedule: JobSpec["schedule"]): string {
  if ("hour" in schedule) return `0 ${schedule.hour} * * *`;
  // A cron step restarts each hour (or day), so only an interval that divides
  // one evenly keeps its cadence.
  const minutes = schedule.everyMinutes;
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours < 24 && 24 % hours === 0)
    return `0 */${hours} * * *`;
  throw new GcError(
    `A crontab line cannot run every ${minutes} minutes; use an interval that divides an hour or a day evenly`,
  );
}
export function jobFiles(
  scheduler: Scheduler,
  job: Job,
): Record<string, string> {
  const command = job.command;
  const spec = job.spec;
  const label = spec.label;
  if (
    [...command, ...Object.values(job.env)].some((value) =>
      /[\r\n\0]/.test(value),
    )
  )
    throw new GcError("Scheduler values cannot contain line breaks or NUL");
  if (scheduler === "launchd")
    return {
      [`${label}.plist`]: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(job.env)
        .map(
          ([key, value]) =>
            `<key>${xml(key)}</key><string>${xml(value)}</string>`,
        )
        .join("")}</dict>
${launchdSchedule(spec.schedule)}
<key>StandardOutPath</key><string>${xml(join(spec.stateRoot, "scheduler.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(spec.stateRoot, "scheduler-error.log"))}</string></dict></plist>\n`,
    };
  // Environment= preserves dollars; ExecStart= requires $$ for a literal.
  // https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
  if (scheduler === "systemd")
    return {
      [`${spec.name}.service`]: `[Unit]\nDescription=${spec.description}\n[Service]\nType=oneshot\nExecStart=${command.map((arg) => systemd(arg.replace(/\$/g, () => "$$"))).join(" ")}\n${Object.entries(
        job.env,
      )
        .map(([key, value]) => `Environment=${systemd(`${key}=${value}`)}`)
        .join("\n")}\n`,
      [timerUnit(spec)]:
        `[Unit]\nDescription=${spec.timerDescription}\n[Timer]\n${systemdSchedule(spec.schedule)}\n[Install]\nWantedBy=timers.target\n`,
    };
  const line = `${cronSchedule(spec.schedule)} ${["env", ...Object.entries(job.env).map(([key, value]) => `${key}=${value}`), ...command].map(quote).join(" ")}`;
  return { crontab: `${cronCommand(line)} ${cronMarker(spec)}\n` };
}
/**
 * Cron reads percent signs before the shell sees quoting: an unescaped one
 * ends the command, and a preceding backslash is its only escape. A value's
 * own backslash before a percent sign would pair with that escape instead,
 * and cron has no spelling for a literal backslash-percent, so it is refused.
 */
function cronCommand(line: string): string {
  if (line.includes("\\%"))
    throw new GcError("Cron values cannot contain a backslash before %");
  return line.split("%").join("\\%");
}
async function execute(
  command: string[],
  stdin?: string,
  announce?: (command: string[]) => void,
): Promise<void> {
  announce?.(command);
  const result = await run(command, {
    timeoutSec: 30,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (result.code !== 0)
    throw new GcError(
      `${command[0]} failed: ${result.stderr || result.stdout}`,
    );
}
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** This machine's scheduler; `unsupported` on a platform with none of them. */
export function detectScheduler(): Outcome<Scheduler, "unsupported"> {
  if (process.platform === "darwin") return ok("launchd");
  if (process.platform !== "linux")
    return failed("unsupported", "GC scheduling supports macOS and Linux");
  // The user manager's socket, where `systemctl --user` itself looks for it.
  const runtime =
    process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
  return ok(
    existsSync(join(runtime, "systemd", "private")) ? "systemd" : "cron",
  );
}
async function crontab(): Promise<string> {
  const result = await run(["crontab", "-l"], { timeoutSec: 30 });
  if (result.code === 0) return result.stdout;
  if (result.code === 1 && /no crontab/i.test(result.stderr)) return "";
  throw new GcError(`Cannot read crontab: ${result.stderr}`);
}
/**
 * Where the job's entry point lives. It is outside every plugin release, so
 * the job does not name one: the launcher finds the installed copy per run.
 */
export function launcherDirectory(spec: JobSpec): string {
  return join(spec.stateRoot, "launcher");
}
/**
 * The agent tools the launcher may ask for the installed plugin copy, by the
 * absolute path found now: a program inside a checkout is never recorded.
 */
export function pluginPrograms(): { claude?: string; codex?: string } {
  const programs: { claude?: string; codex?: string } = {};
  for (const name of ["claude", "codex"] as const) {
    const program = Bun.which(name);
    if (program && outsideCheckout(program)) programs[name] = program;
  }
  return programs;
}
/**
 * Fails an install whose job could not find the plugin it would run: the
 * scheduler reports a job's failures where nobody reads them.
 */
export async function checkLauncherResolves(): Promise<
  Outcome<void, "unresolved">
> {
  try {
    await installedEntry(pluginPrograms());
    return ok(undefined);
  } catch (error) {
    return failed("unresolved", reasonOf(error), error);
  }
}
const LAUNCHER_FILES = ["launcher.ts", "bunfig.toml"];
/**
 * Replaces the launcher and its trusted startup file in `directory`. Both are
 * copied beside their targets before either is replaced, so a failed copy
 * leaves the previous pair in place.
 */
export function installLauncher(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staged = LAUNCHER_FILES.map((name) => ({
    source: join(import.meta.dir, name),
    target: join(directory, name),
    temporary: join(directory, `${name}.${process.pid}.tmp`),
  }));
  try {
    for (const file of staged) copyFileSync(file.source, file.temporary);
    for (const file of staged) renameSync(file.temporary, file.target);
  } finally {
    for (const file of staged) rmSync(file.temporary, { force: true });
  }
}
/**
 * The launcher files in `directory` that differ from this copy's (`source`),
 * a missing one included: what `installLauncher` would replace.
 */
export function staleLauncherFiles(
  directory: string,
  source: string = import.meta.dir,
): string[] {
  return LAUNCHER_FILES.filter(
    (name) =>
      readOptional(join(directory, name)) !==
      readFileSync(join(source, name), "utf8"),
  );
}
/** A `LOCK_TIMEOUT` the heavy-run lock accepts, refused at install otherwise. */
function lockTimeout(value: string): string {
  if (!/^[0-9]+$/.test(value) || Number(value) > MAX_TIMEOUT_SECONDS)
    throw new GcError(
      `LOCK_TIMEOUT must be a whole number of seconds from 0 to ${MAX_TIMEOUT_SECONDS}: ${value}`,
    );
  return value;
}
/** What the job's own spec adds to its environment. */
function specEnvironment(spec: JobSpec): Record<string, string> {
  return {
    ...(spec.deadlineSec === undefined
      ? {}
      : { JIG_LAUNCHER_DEADLINE_SEC: String(spec.deadlineSec) }),
    ...spec.env,
  };
}
/**
 * The command that runs the launcher installed in `directory`, up to the
 * `--` after which the installed `jig.ts` arguments follow: Bun and the agent
 * tools by their absolute paths, the ones found now unless given (a refresh
 * keeps the ones a job recorded).
 */
export function launcherCommand(
  directory: string,
  programs: { claude?: string; codex?: string } = pluginPrograms(),
  bun: string = realpathSync(process.execPath),
): string[] {
  return [
    bun,
    "--no-env-file",
    `--config=${join(directory, "bunfig.toml")}`,
    join(directory, "launcher.ts"),
    ...Object.entries(programs).map(
      ([name, program]) => `--${name}=${program}`,
    ),
    "--",
  ];
}
/** `names`' values in this environment, each resolved to an absolute path, where set. */
function resolvedPaths(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, resolve(value)]] : [];
    }),
  );
}
/** The heavy-run lock's settings the job keeps: where it lives, its name and its wait. */
function lockEnvironment(removing: boolean): Record<string, string> {
  const { LOCK_NAME, LOCK_TIMEOUT } = process.env;
  return {
    ...resolvedPaths(["LOCK_ROOT"]),
    ...(LOCK_NAME ? { LOCK_NAME } : {}),
    // The lock wait, and the launcher's deadline built on it.
    ...(LOCK_TIMEOUT && !removing
      ? { LOCK_TIMEOUT: lockTimeout(LOCK_TIMEOUT) }
      : {}),
  };
}
/** The job to write; a removal names it only, so a bad value cannot block it. */
function installedJob(spec: JobSpec, removing = false): Job {
  return {
    command: [...launcherCommand(launcherDirectory(spec)), ...spec.args],
    env: {
      HOME: homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      JIG_HOME: jigHome(),
      ...resolvedPaths(["TMPDIR"]),
      ...lockEnvironment(removing),
      // The agent tools read their registries from these.
      ...resolvedPaths([
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "DRIVE_PR_STATE_DIR",
      ]),
      ...specEnvironment(spec),
    },
    spec,
  };
}
async function updateCron(
  files: Record<string, string>,
  remove: boolean,
  spec: JobSpec,
  announce?: (command: string[]) => void,
): Promise<string> {
  const previous = await crontab();
  const retained = previous
    .split("\n")
    .filter((line) => !line.endsWith(` ${cronMarker(spec)}`) && line !== "")
    .join("\n");
  await execute(
    ["crontab", "-"],
    `${retained}${retained ? "\n" : ""}${remove ? "" : files.crontab}`,
    announce,
  );
  return `crontab: ${spec.name}`;
}
async function updateLaunchd(
  dir: string,
  files: Record<string, string>,
  remove: boolean,
  spec: JobSpec,
): Promise<string> {
  const LABEL = spec.label;
  const path = join(dir, `${LABEL}.plist`);
  const domain = `gui/${process.getuid?.()}`;
  if (await launchdLoaded(`${domain}/${LABEL}`))
    await execute(["launchctl", "bootout", `${domain}/${LABEL}`]);
  if (remove) rmSync(path, { force: true });
  else {
    writeFileSync(path, files[`${LABEL}.plist`] as string, { mode: 0o600 });
    await execute(["launchctl", "bootstrap", domain, path]);
  }
  return path;
}
async function updateSystemd(
  dir: string,
  files: Record<string, string>,
  remove: boolean,
  spec: JobSpec,
): Promise<string> {
  const timer = timerUnit(spec);
  // systemctl refuses to disable a unit that was never installed.
  if (remove && existsSync(join(dir, timer)))
    await execute(["systemctl", "--user", "disable", "--now", timer]);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    if (remove) rmSync(path, { force: true });
    else writeFileSync(path, text, { mode: 0o600 });
  }
  await execute(["systemctl", "--user", "daemon-reload"]);
  if (!remove) await execute(["systemctl", "--user", "enable", "--now", timer]);
  return join(dir, timer);
}
function jobDirectory(scheduler: "launchd" | "systemd"): string {
  return scheduler === "launchd"
    ? join(homedir(), "Library", "LaunchAgents")
    : join(homedir(), ".config", "systemd", "user");
}
async function applyJob(
  scheduler: Scheduler,
  files: Record<string, string>,
  remove: boolean,
  spec: JobSpec,
): Promise<string> {
  if (scheduler === "cron") return updateCron(files, remove, spec);
  const dir = jobDirectory(scheduler);
  mkdirSync(dir, { recursive: true });
  return scheduler === "launchd"
    ? updateLaunchd(dir, files, remove, spec)
    : updateSystemd(dir, files, remove, spec);
}
/**
 * Write, or with `remove` take away, the job `spec` names: where it is, or
 * why it could not be written, what the scheduler or the file system said.
 */
export async function updateJob(
  spec: JobSpec,
  remove = false,
): Promise<Outcome<string, "scheduler-failed">> {
  const scheduler = detectScheduler();
  if (!scheduler.ok)
    return failed("scheduler-failed", scheduler.failure.reason);
  try {
    // A removal names the job only: the cadence it would have is not rendered.
    const named = remove ? { ...spec, schedule: { hour: 0 } } : spec;
    const files = jobFiles(scheduler.value, installedJob(named, remove));
    mkdirSync(spec.stateRoot, { recursive: true, mode: 0o700 });
    // In place before the job that runs it, and gone only after that job is.
    if (!remove) installLauncher(launcherDirectory(spec));
    const job = await applyJob(scheduler.value, files, remove, spec);
    if (remove)
      rmSync(launcherDirectory(spec), { recursive: true, force: true });
    return ok(job);
  } catch (error) {
    return failed("scheduler-failed", reasonOf(error), error);
  }
}
/**
 * The job as it stood before an update: its files' text, whether it starts on
 * its own (`enabled`) and whether it is running now (`active`). systemd keeps
 * the two independently, so each is captured and restored on its own; for
 * launchd and cron a loaded job is both. `launcher` holds the files the job
 * runs, `null` for one that did not exist, since an update replaces them too.
 */
export interface SchedulerSnapshot {
  scheduler: Scheduler;
  spec: JobSpec;
  files: Record<string, string | null>;
  launcher: Record<string, string | null>;
  enabled: boolean;
  active: boolean;
}
/** The launcher files in `directory` as they are now, `null` for one that is missing. */
export function launcherSnapshotIn(
  directory: string,
): Record<string, string | null> {
  return Object.fromEntries(
    LAUNCHER_FILES.map((name) => {
      const path = join(directory, name);
      return [path, readOptional(path)];
    }),
  );
}
function launcherSnapshot(spec: JobSpec): Record<string, string | null> {
  return launcherSnapshotIn(launcherDirectory(spec));
}
/**
 * Runs `write`, which replaces the launcher files in `directory`; a failure
 * puts back `previous` (what `launcherSnapshotIn` saw before), and its
 * reason says when that could not be done.
 */
export function guardLauncher(
  directory: string,
  previous: Record<string, string | null>,
  write: () => void,
): Outcome<void, "not-written"> {
  try {
    write();
    return ok(undefined);
  } catch (error) {
    try {
      restoreLauncher(previous, directory);
    } catch (restoring) {
      return failed(
        "not-written",
        `${reasonOf(error)}; the previous launcher copy was not restored: ${reasonOf(restoring)}`,
        error,
      );
    }
    return failed("not-written", reasonOf(error), error);
  }
}
/** Puts back the launcher files the snapshot saw, each staged then renamed. */
function restoreLauncher(
  launcher: Record<string, string | null>,
  directory: string,
): void {
  const entries = Object.entries(launcher);
  if (entries.every(([, text]) => text === null)) {
    rmSync(directory, { recursive: true, force: true });
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = (path: string) => `${path}.${process.pid}.tmp`;
  try {
    for (const [path, text] of entries)
      if (text !== null) writeFileSync(temporary(path), text, { mode: 0o600 });
    for (const [path, text] of entries)
      if (text === null) rmSync(path, { force: true });
      else renameSync(temporary(path), path);
  } finally {
    for (const [path] of entries) rmSync(temporary(path), { force: true });
  }
}
function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** A scheduler query that answered nothing usable: never read as absence. */
function unreadable(
  command: string[],
  result: Awaited<ReturnType<typeof run>>,
): GcError {
  const how = result.timedOut
    ? "timed out"
    : result.spawnFailed
      ? "could not start"
      : `exited ${result.code}`;
  return new GcError(
    `Cannot establish scheduler state: ${command.join(" ")} ${how}: ${(result.stderr || result.stdout).trim()}`,
  );
}
/**
 * A probe answers yes, answers a documented no, or establishes nothing. Only
 * the first two are state: a timeout, a spawn failure or an unrecognised
 * answer throws, so an unreadable state is never recorded as an absent one.
 * `negative` names the documented "no" answers.
 */
async function probe(
  command: string[],
  negative: (result: { code: number; stdout: string }) => boolean,
): Promise<boolean> {
  const result = await run(command, { timeoutSec: 30 });
  if (!result.timedOut && !result.spawnFailed) {
    if (result.code === 0) return true;
    if (negative(result)) return false;
  }
  throw unreadable(command, result);
}
// launchctl print exits 113 for a service it does not know.
function launchdLoaded(target: string): Promise<boolean> {
  return probe(["launchctl", "print", target], ({ code }) => code === 113);
}
// https://www.freedesktop.org/software/systemd/man/latest/systemctl.html
// `is-enabled` reports a missing unit differently across systemd versions
// (`not-found` on stdout, or only a diagnostic on stderr), so state is read
// through `show`, which answers for a missing unit with `LoadState=not-found`
// and exits non-zero only when the manager itself cannot be asked.
const ENABLED = new Set([
  "enabled",
  "enabled-runtime",
  "static",
  "alias",
  "indirect",
  "generated",
  "transient",
]);
const NOT_ENABLED = new Set([
  "disabled",
  "linked",
  "linked-runtime",
  "masked",
  "masked-runtime",
]);
const ACTIVE = new Set(["active", "reloading", "refreshing"]);
const NOT_ACTIVE = new Set([
  "inactive",
  "failed",
  "activating",
  "deactivating",
]);
function classify(
  name: string,
  value: string | undefined,
  yes: Set<string>,
  no: Set<string>,
  timer: string,
): boolean {
  if (value !== undefined && yes.has(value)) return true;
  if (value !== undefined && no.has(value)) return false;
  throw new GcError(
    `Cannot establish scheduler state: systemctl reported ${name}=${value ?? "(missing)"} for ${timer}`,
  );
}
async function systemdState(
  timer: string,
): Promise<{ enabled: boolean; active: boolean }> {
  const command = [
    "systemctl",
    "--user",
    "show",
    timer,
    "--property=LoadState,UnitFileState,ActiveState",
  ];
  const result = await run(command, { timeoutSec: 30 });
  if (result.timedOut || result.spawnFailed || result.code !== 0)
    throw unreadable(command, result);
  const props = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) props.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const load = props.get("LoadState");
  if (load === undefined)
    throw new GcError(
      `Cannot establish scheduler state: systemctl reported no LoadState for ${timer}`,
    );
  return {
    enabled:
      load !== "not-found" &&
      classify(
        "UnitFileState",
        props.get("UnitFileState"),
        ENABLED,
        NOT_ENABLED,
        timer,
      ),
    active: classify(
      "ActiveState",
      props.get("ActiveState"),
      ACTIVE,
      NOT_ACTIVE,
      timer,
    ),
  };
}
/**
 * The job `spec` names as `scheduler` holds it now, or why its state cannot
 * be established: an unreadable state is never read as an absent job.
 */
export async function snapshotScheduler(
  scheduler: Scheduler,
  spec: JobSpec,
): Promise<Outcome<SchedulerSnapshot, "unreadable">> {
  try {
    return ok(await readSnapshot(scheduler, spec));
  } catch (error) {
    return failed("unreadable", reasonOf(error), error);
  }
}
async function readSnapshot(
  scheduler: Scheduler,
  spec: JobSpec,
): Promise<SchedulerSnapshot> {
  const launcher = launcherSnapshot(spec);
  const LABEL = spec.label;
  if (scheduler === "cron")
    return {
      scheduler,
      spec,
      files: { crontab: await crontab() },
      launcher,
      enabled: true,
      active: true,
    };
  const dir = jobDirectory(scheduler);
  const names =
    scheduler === "launchd"
      ? [`${LABEL}.plist`]
      : [`${spec.name}.service`, timerUnit(spec)];
  const files = Object.fromEntries(
    names.map((name) => [join(dir, name), readOptional(join(dir, name))]),
  );
  if (scheduler === "launchd") {
    const loaded = await launchdLoaded(`gui/${process.getuid?.()}/${LABEL}`);
    return {
      scheduler,
      spec,
      files,
      launcher,
      enabled: loaded,
      active: loaded,
    };
  }
  return {
    scheduler,
    spec,
    files,
    launcher,
    ...(await systemdState(timerUnit(spec))),
  };
}
/** Stops the replacement job; only a timer never installed may be skipped. */
async function stopReplacement(launchd: boolean, spec: JobSpec): Promise<void> {
  const timer = timerUnit(spec);
  if (launchd) {
    const target = `gui/${process.getuid?.()}/${spec.label}`;
    if (await launchdLoaded(target))
      await execute(["launchctl", "bootout", target]);
  } else if (existsSync(join(jobDirectory("systemd"), timer)))
    await execute(["systemctl", "--user", "disable", "--now", timer]);
}
async function startPrevious(snapshot: SchedulerSnapshot): Promise<void> {
  if (snapshot.scheduler === "launchd") {
    const [plist] = Object.keys(snapshot.files);
    if (snapshot.active && plist)
      await execute([
        "launchctl",
        "bootstrap",
        `gui/${process.getuid?.()}`,
        plist,
      ]);
    return;
  }
  const timer = timerUnit(snapshot.spec);
  await execute(["systemctl", "--user", "daemon-reload"]);
  if (snapshot.enabled) await execute(["systemctl", "--user", "enable", timer]);
  if (snapshot.active) await execute(["systemctl", "--user", "start", timer]);
}
/** Writes back the snapshot's exact files and states, not a rebuilt job; or why it could not. */
export async function restoreScheduler(
  snapshot: SchedulerSnapshot,
): Promise<Outcome<void, "not-restored">> {
  try {
    await restore(snapshot);
    return ok(undefined);
  } catch (error) {
    return failed("not-restored", reasonOf(error), error);
  }
}
async function restore(snapshot: SchedulerSnapshot): Promise<void> {
  // In place before the restored job can start and run it.
  restoreLauncher(snapshot.launcher, launcherDirectory(snapshot.spec));
  if (snapshot.scheduler === "cron") {
    await execute(["crontab", "-"], snapshot.files.crontab ?? "");
    return;
  }
  await stopReplacement(snapshot.scheduler === "launchd", snapshot.spec);
  for (const [path, text] of Object.entries(snapshot.files))
    if (text === null) rmSync(path, { force: true });
    else writeFileSync(path, text, { mode: 0o600 });
  await startPrevious(snapshot);
}
/** Whether `files` (from `jobFiles`) differ from the job the snapshot saw. */
export function jobChanged(
  snapshot: SchedulerSnapshot,
  files: Record<string, string>,
): boolean {
  if (snapshot.scheduler === "cron") {
    const marker = ` ${cronMarker(snapshot.spec)}`;
    const line = (snapshot.files.crontab ?? "")
      .split("\n")
      .find((entry) => entry.endsWith(marker));
    return `${line}\n` !== files.crontab;
  }
  const dir = jobDirectory(snapshot.scheduler);
  return Object.entries(files).some(
    ([name, text]) => snapshot.files[join(dir, name)] !== text,
  );
}
/**
 * Writes `files` in place of the installed job the snapshot saw, leaving
 * whether it is enabled and running as it was: a refresh changes what the
 * job runs, never whether it runs. A launchd job that is loaded is booted out
 * and in again to read its new file. A failure puts the snapshot back, the
 * launcher files included, and its reason says whether that was done.
 * `announce` sees each scheduler command first.
 */
export async function rewriteJob(
  snapshot: SchedulerSnapshot,
  files: Record<string, string>,
  announce?: (command: string[]) => void,
): Promise<Outcome<void, "not-rewritten">> {
  try {
    await rewrite(snapshot, files, announce);
    return ok(undefined);
  } catch (error) {
    const restored = await restoreScheduler(snapshot);
    return failed(
      "not-rewritten",
      restored.ok
        ? `${reasonOf(error)}; the previous scheduler job is restored`
        : `${reasonOf(error)}; previous scheduler job not restored: ${restored.failure.reason}`,
      error,
    );
  }
}
async function rewrite(
  snapshot: SchedulerSnapshot,
  files: Record<string, string>,
  announce?: (command: string[]) => void,
): Promise<void> {
  const { scheduler, spec } = snapshot;
  if (scheduler === "cron") {
    await updateCron(files, false, spec, announce);
    return;
  }
  const dir = jobDirectory(scheduler);
  if (scheduler === "systemd") {
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text, { mode: 0o600 });
    await execute(
      ["systemctl", "--user", "daemon-reload"],
      undefined,
      announce,
    );
    return;
  }
  const path = join(dir, `${spec.label}.plist`);
  const domain = `gui/${process.getuid?.()}`;
  if (snapshot.active)
    await execute(
      ["launchctl", "bootout", `${domain}/${spec.label}`],
      undefined,
      announce,
    );
  writeFileSync(path, files[`${spec.label}.plist`] as string, {
    mode: 0o600,
  });
  if (snapshot.active)
    await execute(
      ["launchctl", "bootstrap", domain, path],
      undefined,
      announce,
    );
}
/** The concrete job `spec` names, as a confirmed install would write it. */
export function jobPreview(spec: JobSpec, remove: boolean): string {
  const detected = detectScheduler();
  if (!detected.ok)
    return `Scheduler preview unavailable: ${detected.failure.reason}`;
  const scheduler = detected.value;
  if (remove)
    return `Scheduler preview (${scheduler}): the ${spec.name} job is removed`;
  const files = jobFiles(scheduler, installedJob(spec));
  return [
    `Scheduler preview (${scheduler}):`,
    ...Object.entries(files).map(([name, text]) => `--- ${name}\n${text}`),
  ].join("\n");
}
export function installedScript(script: string): boolean {
  return outsideCheckout(script);
}
