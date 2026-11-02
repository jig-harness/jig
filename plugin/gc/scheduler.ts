import { jigHome } from "../shared/config-layers.ts";
import { GcError } from "../shared/gc-error.ts";
/** Platform schedulers run an installed copy with an explicit environment. */
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
import { run } from "../shared/proc.ts";
import { MAX_TIMEOUT_SECONDS } from "../shared/resource-lock.ts";
import { installedEntry, outsideCheckout } from "./launcher.ts";
import type { MachineConfig } from "./config.ts";
import { gcJobSpec, type JobSpec } from "./job-spec.ts";

export type { JobSpec } from "./job-spec.ts";
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
  hour: number;
  /** The job written; resource collection's daily one, at `hour`, when absent. */
  spec?: JobSpec;
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
    : `OnActiveSec=1min\nOnUnitActiveSec=${schedule.everyMinutes}min`;
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
  const spec = job.spec ?? gcJobSpec(job.hour);
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
async function execute(command: string[], stdin?: string): Promise<void> {
  const result = await run(command, {
    timeoutSec: 30,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (result.code !== 0)
    throw new GcError(
      `${command[0]} failed: ${result.stderr || result.stdout}`,
    );
}
function detectScheduler(): Scheduler {
  if (process.platform === "darwin") return "launchd";
  if (process.platform !== "linux")
    throw new GcError("GC scheduling supports macOS and Linux");
  // The user manager's socket, where `systemctl --user` itself looks for it.
  const runtime =
    process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
  return existsSync(join(runtime, "systemd", "private")) ? "systemd" : "cron";
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
function launcherDirectory(spec: JobSpec): string {
  return join(spec.stateRoot, "launcher");
}
/**
 * The agent tools the launcher may ask for the installed plugin copy, by the
 * absolute path found now: a program inside a checkout is never recorded.
 */
function pluginPrograms(): { claude?: string; codex?: string } {
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
export async function checkLauncherResolves(): Promise<void> {
  try {
    await installedEntry(pluginPrograms());
  } catch (error) {
    throw new GcError((error as Error).message);
  }
}
const LAUNCHER_FILES = ["launcher.ts", "bunfig.toml"];
/**
 * Replaces the launcher and its trusted startup file. Both are copied beside
 * their targets before either is replaced, so a failed copy leaves the
 * previous pair in place.
 */
function installLauncher(spec: JobSpec): void {
  const directory = launcherDirectory(spec);
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
/** The job to write; a removal names it only, so a bad value cannot block it. */
function installedJob(spec: JobSpec, removing = false): Job {
  const root = homedir();
  const directory = launcherDirectory(spec);
  return {
    command: [
      realpathSync(process.execPath),
      "--no-env-file",
      `--config=${join(directory, "bunfig.toml")}`,
      join(directory, "launcher.ts"),
      ...Object.entries(pluginPrograms()).map(
        ([name, program]) => `--${name}=${program}`,
      ),
      "--",
      ...spec.args,
    ],
    env: {
      HOME: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      JIG_HOME: jigHome(),
      ...(process.env.TMPDIR ? { TMPDIR: resolve(process.env.TMPDIR) } : {}),
      ...(process.env.LOCK_ROOT
        ? { LOCK_ROOT: resolve(process.env.LOCK_ROOT) }
        : {}),
      ...(process.env.LOCK_NAME ? { LOCK_NAME: process.env.LOCK_NAME } : {}),
      // The lock wait, and the launcher's deadline built on it.
      ...(process.env.LOCK_TIMEOUT && !removing
        ? { LOCK_TIMEOUT: lockTimeout(process.env.LOCK_TIMEOUT) }
        : {}),
      // The agent tools read their registries from these.
      ...(process.env.CLAUDE_CONFIG_DIR
        ? { CLAUDE_CONFIG_DIR: resolve(process.env.CLAUDE_CONFIG_DIR) }
        : {}),
      ...(process.env.CODEX_HOME
        ? { CODEX_HOME: resolve(process.env.CODEX_HOME) }
        : {}),
      ...(process.env.DRIVE_PR_STATE_DIR
        ? { DRIVE_PR_STATE_DIR: resolve(process.env.DRIVE_PR_STATE_DIR) }
        : {}),
      ...specEnvironment(spec),
    },
    hour: "hour" in spec.schedule ? spec.schedule.hour : 0,
    spec,
  };
}
async function updateCron(
  files: Record<string, string>,
  remove: boolean,
  spec: JobSpec,
): Promise<string> {
  const previous = await crontab();
  const retained = previous
    .split("\n")
    .filter((line) => !line.endsWith(` ${cronMarker(spec)}`) && line !== "")
    .join("\n");
  await execute(
    ["crontab", "-"],
    `${retained}${retained ? "\n" : ""}${remove ? "" : files.crontab}`,
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
export async function updateScheduler(
  machine: MachineConfig,
  remove = false,
): Promise<string> {
  return updateJob(gcJobSpec(machine.hour), remove);
}
/** Write, or with `remove` take away, the job `spec` names. */
export async function updateJob(
  spec: JobSpec,
  remove = false,
): Promise<string> {
  const scheduler = detectScheduler();
  // A removal names the job only: the cadence it would have is not rendered.
  const named = remove ? { ...spec, schedule: { hour: 0 } } : spec;
  const files = jobFiles(scheduler, installedJob(named, remove));
  mkdirSync(spec.stateRoot, { recursive: true, mode: 0o700 });
  // In place before the job that runs it, and gone only after that job is.
  if (!remove) installLauncher(spec);
  const job = await applyJob(scheduler, files, remove, spec);
  if (remove) rmSync(launcherDirectory(spec), { recursive: true, force: true });
  return job;
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
function launcherSnapshot(spec: JobSpec): Record<string, string | null> {
  return Object.fromEntries(
    LAUNCHER_FILES.map((name) => {
      const path = join(launcherDirectory(spec), name);
      return [path, readOptional(path)];
    }),
  );
}
/** Puts back the launcher files the snapshot saw, each staged then renamed. */
function restoreLauncher(
  launcher: Record<string, string | null>,
  spec: JobSpec,
): void {
  const entries = Object.entries(launcher);
  if (entries.every(([, text]) => text === null)) {
    rmSync(launcherDirectory(spec), { recursive: true, force: true });
    return;
  }
  mkdirSync(launcherDirectory(spec), { recursive: true, mode: 0o700 });
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
export async function snapshotScheduler(
  scheduler: Scheduler = detectScheduler(),
  spec: JobSpec = gcJobSpec(),
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
/** Writes back the snapshot's exact files and states, not a rebuilt job. */
export async function restoreScheduler(
  snapshot: SchedulerSnapshot,
): Promise<void> {
  // In place before the restored job can start and run it.
  restoreLauncher(snapshot.launcher, snapshot.spec);
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
/** The concrete job a confirmed install would write, shown before confirmation. */
export function schedulerPreview(
  machine: MachineConfig,
  remove: boolean,
): string {
  return jobPreview(gcJobSpec(machine.hour), remove);
}
/** The concrete job `spec` names, as a confirmed install would write it. */
export function jobPreview(spec: JobSpec, remove: boolean): string {
  let scheduler: Scheduler;
  try {
    scheduler = detectScheduler();
  } catch (error) {
    return `Scheduler preview unavailable: ${(error as Error).message}`;
  }
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
/** Preserve unrelated YAML settings when only the machine's gc entry changes. */
export function previousMachineText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
