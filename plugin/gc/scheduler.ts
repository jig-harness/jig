import { jigHome } from "../shared/config-layers.ts";
import { GcError } from "../shared/gc-error.ts";
/** Platform schedulers run an installed copy with an explicit environment. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { run } from "../shared/proc.ts";
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
  return existsSync(`/run/user/${process.getuid?.()}/systemd/private`)
    ? "systemd"
    : "cron";
}
async function crontab(): Promise<string> {
  const result = await run(["crontab", "-l"], { timeoutSec: 30 });
  if (result.code === 0) return result.stdout;
  if (result.code === 1 && /no crontab/i.test(result.stderr)) return "";
  throw new GcError(`Cannot read crontab: ${result.stderr}`);
}
function installedJob(machine: MachineConfig, script: string): Job {
  const root = homedir();
  return {
    command: [
      realpathSync(process.execPath),
      "--no-env-file",
      `--config=${join(dirname(realpathSync(script)), "gc", "bunfig.toml")}`,
      realpathSync(script),
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
export async function updateScheduler(
  machine: MachineConfig,
  script: string,
  remove = false,
): Promise<string> {
  const scheduler = detectScheduler();
  const files = jobFiles(scheduler, installedJob(machine, script));
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  if (scheduler === "cron") return updateCron(files, remove);
  const dir = jobDirectory(scheduler);
  mkdirSync(dir, { recursive: true });
  return scheduler === "launchd"
    ? updateLaunchd(dir, files, remove)
    : updateSystemd(dir, files, remove);
}
/**
 * The job as it stood before an update: its files' text, whether it starts on
 * its own (`enabled`) and whether it is running now (`active`). systemd keeps
 * the two independently, so each is captured and restored on its own; for
 * launchd and cron a loaded job is both.
 */
export interface SchedulerSnapshot {
  scheduler: Scheduler;
  files: Record<string, string | null>;
  enabled: boolean;
  active: boolean;
}
function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/**
 * A probe answers yes, answers a documented no, or establishes nothing. Only
 * the first two are state: a timeout, a spawn failure or an unrecognised
 * answer throws, so an unreadable state is never recorded as an absent one.
 * `negative` names the documented "no" answers; `state` reads one from output.
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
  const how = result.timedOut
    ? "timed out"
    : result.spawnFailed
      ? "could not start"
      : `exited ${result.code}`;
  throw new GcError(
    `Cannot establish scheduler state: ${command.join(" ")} ${how}: ${(result.stderr || result.stdout).trim()}`,
  );
}
function state(stdout: string): string {
  return stdout.trim().split("\n")[0] ?? "";
}
// launchctl print exits 113 for a service it does not know.
function launchdLoaded(target: string): Promise<boolean> {
  return probe(["launchctl", "print", target], ({ code }) => code === 113);
}
// https://www.freedesktop.org/software/systemd/man/latest/systemctl.html
const NOT_ENABLED = new Set([
  "disabled",
  "linked",
  "linked-runtime",
  "masked",
  "masked-runtime",
  "not-found",
]);
const NOT_ACTIVE = new Set([
  "inactive",
  "failed",
  "activating",
  "deactivating",
]);
function systemdState(verb: string, negative: Set<string>): Promise<boolean> {
  return probe(["systemctl", "--user", verb, "jig-gc.timer"], ({ stdout }) =>
    negative.has(state(stdout)),
  );
}
export async function snapshotScheduler(
  scheduler: Scheduler = detectScheduler(),
): Promise<SchedulerSnapshot> {
  if (scheduler === "cron")
    return {
      scheduler,
      files: { crontab: await crontab() },
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
    return { scheduler, files, enabled: loaded, active: loaded };
  }
  return {
    scheduler,
    files,
    enabled: await systemdState("is-enabled", NOT_ENABLED),
    active: await systemdState("is-active", NOT_ACTIVE),
  };
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
  script: string,
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
  const files = jobFiles(scheduler, installedJob(machine, script));
  return [
    `Scheduler preview (${scheduler}):`,
    ...Object.entries(files).map(([name, text]) => `--- ${name}\n${text}`),
  ].join("\n");
}
export function installedScript(script: string): boolean {
  let current = dirname(realpathSync(script));
  for (;;) {
    if (existsSync(join(current, ".git"))) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
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
