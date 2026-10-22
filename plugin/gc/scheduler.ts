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
  // Cron interprets percent signs before the shell sees quoting.
  const line = `0 ${job.hour} * * * ${["env", ...Object.entries(job.env).map(([key, value]) => `${key}=${value}`), ...command].map(quote).join(" ")}`;
  return { crontab: `${line.replace(/%/g, "\\%")} ${CRON_MARKER}\n` };
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
  const loaded = await run(["launchctl", "print", `${domain}/${LABEL}`], {
    timeoutSec: 30,
  });
  if (loaded.code === 0)
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
  if (remove)
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
export async function updateScheduler(
  machine: MachineConfig,
  script: string,
  remove = false,
): Promise<string> {
  const scheduler = detectScheduler();
  const files = jobFiles(scheduler, installedJob(machine, script));
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  if (scheduler === "cron") return updateCron(files, remove);
  const dir =
    scheduler === "launchd"
      ? join(homedir(), "Library", "LaunchAgents")
      : join(homedir(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  return scheduler === "launchd"
    ? updateLaunchd(dir, files, remove)
    : updateSystemd(dir, files, remove);
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
