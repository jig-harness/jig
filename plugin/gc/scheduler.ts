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
import { stateRoot } from "./receipts.ts";

const LABEL = "dev.jig.gc";
const CRON_MARKER = "# jig-gc";
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
}
export function jobFiles(
  scheduler: Scheduler,
  job: Job,
): Record<string, string> {
  const command = job.command;
  if (
    [...command, ...Object.values(job.env)].some((value) =>
      /[\r\n\0]/.test(value),
    )
  )
    throw new GcError("Scheduler values cannot contain line breaks or NUL");
  if (scheduler === "launchd")
    return {
      [`${LABEL}.plist`]: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(job.env)
        .map(
          ([key, value]) =>
            `<key>${xml(key)}</key><string>${xml(value)}</string>`,
        )
        .join("")}</dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${job.hour}</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>${xml(join(stateRoot(), "scheduler.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateRoot(), "scheduler-error.log"))}</string></dict></plist>\n`,
    };
  // Environment= preserves dollars; ExecStart= requires $$ for a literal.
  // https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
  if (scheduler === "systemd")
    return {
      "jig-gc.service": `[Unit]\nDescription=Jig resource collection\n[Service]\nType=oneshot\nExecStart=${command.map((arg) => systemd(arg.replace(/\$/g, () => "$$"))).join(" ")}\n${Object.entries(
        job.env,
      )
        .map(([key, value]) => `Environment=${systemd(`${key}=${value}`)}`)
        .join("\n")}\n`,
      "jig-gc.timer": `[Unit]\nDescription=Daily Jig resource report\n[Timer]\nOnCalendar=*-*-* ${String(job.hour).padStart(2, "0")}:00:00\nPersistent=true\n[Install]\nWantedBy=timers.target\n`,
    };
  const line = `0 ${job.hour} * * * ${["env", ...Object.entries(job.env).map(([key, value]) => `${key}=${value}`), ...command].map(quote).join(" ")}`;
  return { crontab: `${cronCommand(line)} ${CRON_MARKER}\n` };
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
function launcherDirectory(): string {
  return join(stateRoot(), "launcher");
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
export function checkLauncherResolves(): void {
  try {
    installedEntry(pluginPrograms());
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
function installLauncher(): void {
  const directory = launcherDirectory();
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
/** The job to write; a removal names it only, so a bad value cannot block it. */
function installedJob(machine: MachineConfig, removing = false): Job {
  const root = homedir();
  const directory = launcherDirectory();
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
      "gc",
      "--scheduled",
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
    },
    hour: machine.hour,
  };
}
async function updateCron(
  files: Record<string, string>,
  remove: boolean,
): Promise<string> {
  const previous = await crontab();
  const retained = previous
    .split("\n")
    .filter((line) => !line.endsWith(` ${CRON_MARKER}`) && line !== "")
    .join("\n");
  await execute(
    ["crontab", "-"],
    `${retained}${retained ? "\n" : ""}${remove ? "" : files.crontab}`,
  );
  return "crontab: jig-gc";
}
async function updateLaunchd(
  dir: string,
  files: Record<string, string>,
  remove: boolean,
): Promise<string> {
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
): Promise<string> {
  // systemctl refuses to disable a unit that was never installed.
  if (remove && existsSync(join(dir, "jig-gc.timer")))
    await execute(["systemctl", "--user", "disable", "--now", "jig-gc.timer"]);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    if (remove) rmSync(path, { force: true });
    else writeFileSync(path, text, { mode: 0o600 });
  }
  await execute(["systemctl", "--user", "daemon-reload"]);
  if (!remove)
    await execute(["systemctl", "--user", "enable", "--now", "jig-gc.timer"]);
  return join(dir, "jig-gc.timer");
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
): Promise<string> {
  if (scheduler === "cron") return updateCron(files, remove);
  const dir = jobDirectory(scheduler);
  mkdirSync(dir, { recursive: true });
  return scheduler === "launchd"
    ? updateLaunchd(dir, files, remove)
    : updateSystemd(dir, files, remove);
}
export async function updateScheduler(
  machine: MachineConfig,
  remove = false,
): Promise<string> {
  const scheduler = detectScheduler();
  const files = jobFiles(scheduler, installedJob(machine, remove));
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  // In place before the job that runs it, and gone only after that job is.
  if (!remove) installLauncher();
  const job = await applyJob(scheduler, files, remove);
  if (remove) rmSync(launcherDirectory(), { recursive: true, force: true });
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
  files: Record<string, string | null>;
  launcher: Record<string, string | null>;
  enabled: boolean;
  active: boolean;
}
function launcherSnapshot(): Record<string, string | null> {
  return Object.fromEntries(
    LAUNCHER_FILES.map((name) => {
      const path = join(launcherDirectory(), name);
      return [path, readOptional(path)];
    }),
  );
}
/** Puts back the launcher files the snapshot saw, each staged then renamed. */
function restoreLauncher(launcher: Record<string, string | null>): void {
  const entries = Object.entries(launcher);
  if (entries.every(([, text]) => text === null)) {
    rmSync(launcherDirectory(), { recursive: true, force: true });
    return;
  }
  mkdirSync(launcherDirectory(), { recursive: true, mode: 0o700 });
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
): boolean {
  if (value !== undefined && yes.has(value)) return true;
  if (value !== undefined && no.has(value)) return false;
  throw new GcError(
    `Cannot establish scheduler state: systemctl reported ${name}=${value ?? "(missing)"} for jig-gc.timer`,
  );
}
async function systemdState(): Promise<{ enabled: boolean; active: boolean }> {
  const command = [
    "systemctl",
    "--user",
    "show",
    "jig-gc.timer",
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
      "Cannot establish scheduler state: systemctl reported no LoadState for jig-gc.timer",
    );
  return {
    enabled:
      load !== "not-found" &&
      classify(
        "UnitFileState",
        props.get("UnitFileState"),
        ENABLED,
        NOT_ENABLED,
      ),
    active: classify(
      "ActiveState",
      props.get("ActiveState"),
      ACTIVE,
      NOT_ACTIVE,
    ),
  };
}
export async function snapshotScheduler(
  scheduler: Scheduler = detectScheduler(),
): Promise<SchedulerSnapshot> {
  const launcher = launcherSnapshot();
  if (scheduler === "cron")
    return {
      scheduler,
      files: { crontab: await crontab() },
      launcher,
      enabled: true,
      active: true,
    };
  const dir = jobDirectory(scheduler);
  const names =
    scheduler === "launchd"
      ? [`${LABEL}.plist`]
      : ["jig-gc.service", "jig-gc.timer"];
  const files = Object.fromEntries(
    names.map((name) => [join(dir, name), readOptional(join(dir, name))]),
  );
  if (scheduler === "launchd") {
    const loaded = await launchdLoaded(`gui/${process.getuid?.()}/${LABEL}`);
    return { scheduler, files, launcher, enabled: loaded, active: loaded };
  }
  return { scheduler, files, launcher, ...(await systemdState()) };
}
/** Stops the replacement job; only a timer never installed may be skipped. */
async function stopReplacement(launchd: boolean): Promise<void> {
  if (launchd) {
    const target = `gui/${process.getuid?.()}/${LABEL}`;
    if (await launchdLoaded(target))
      await execute(["launchctl", "bootout", target]);
  } else if (existsSync(join(jobDirectory("systemd"), "jig-gc.timer")))
    await execute(["systemctl", "--user", "disable", "--now", "jig-gc.timer"]);
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
  await execute(["systemctl", "--user", "daemon-reload"]);
  if (snapshot.enabled)
    await execute(["systemctl", "--user", "enable", "jig-gc.timer"]);
  if (snapshot.active)
    await execute(["systemctl", "--user", "start", "jig-gc.timer"]);
}
/** Writes back the snapshot's exact files and states, not a rebuilt job. */
export async function restoreScheduler(
  snapshot: SchedulerSnapshot,
): Promise<void> {
  // In place before the restored job can start and run it.
  restoreLauncher(snapshot.launcher);
  if (snapshot.scheduler === "cron") {
    await execute(["crontab", "-"], snapshot.files.crontab ?? "");
    return;
  }
  await stopReplacement(snapshot.scheduler === "launchd");
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
  let scheduler: Scheduler;
  try {
    scheduler = detectScheduler();
  } catch (error) {
    return `Scheduler preview unavailable: ${(error as Error).message}`;
  }
  if (remove)
    return `Scheduler preview (${scheduler}): the jig-gc job is removed`;
  const files = jobFiles(scheduler, installedJob(machine));
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
