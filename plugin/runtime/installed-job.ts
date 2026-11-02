/**
 * What an installed job holds, read back from the scheduler's own text (the
 * forms `jobFiles` in `scheduler.ts` writes): the command it runs, the
 * environment it runs with, its schedule and, on systemd, its descriptions;
 * and what the `jig` command's script runs. `jig upgrade` rewrites a job from
 * these (`refresh.ts`), so a new release changes only the form it writes and
 * never what the install recorded, and `jig doctor` checks the programs a job
 * names.
 */
import type { JobSpec } from "./job-spec.ts";
import { installedSchedule } from "./job-status.ts";
import type { SchedulerSnapshot } from "./scheduler.ts";

export interface InstalledJob {
  /** The launcher's command, then `--`, then the `jig.ts` arguments. */
  command: string[];
  env: Record<string, string>;
  schedule: JobSpec["schedule"] | null;
  /** The service's and the timer's descriptions, which only systemd keeps. */
  description?: string;
  timerDescription?: string;
}

/** The programs a launcher command names, and the arguments it passes on. */
export interface LauncherCall {
  /** The Bun that runs the launcher. */
  bun: string;
  /** The agent tools the launcher asks for the installed plugin copy. */
  programs: { claude?: string; codex?: string };
  /** The `jig.ts` arguments, after `--`. */
  args: string[];
}

/** `command` split into its parts; null when it is not a launcher's command. */
export function launcherCall(command: readonly string[]): LauncherCall | null {
  const separator = command.indexOf("--");
  const bun = command[0];
  if (separator < 1 || bun === undefined) return null;
  const programs: LauncherCall["programs"] = {};
  for (const value of command.slice(1, separator)) {
    const match = /^--(claude|codex)=(.+)$/.exec(value);
    if (match) programs[match[1] as "claude" | "codex"] = match[2] as string;
  }
  return { bun, programs, args: command.slice(separator + 1) };
}

/** One shell word: single-quoted runs, backslash escapes and plain characters, with no space between. */
const SHELL_WORD = /(?:'[^']*'|\\.|[^\s'\\])+/g;

/**
 * The words of a POSIX shell command line as `quote` in `scheduler.ts` and
 * `path-command.ts` writes them: single-quoted, a quote inside written
 * `'\''`, separated by spaces. Null for a quote left open.
 */
export function shellWords(text: string): string[] | null {
  // What no word takes is spaces, or a quote left open.
  if (text.replace(SHELL_WORD, "").trim() !== "") return null;
  return (text.match(SHELL_WORD) ?? []).map((word) =>
    word.replace(
      /'([^']*)'|\\(.)/g,
      (_, quoted: string | undefined, escaped: string | undefined) =>
        quoted ?? escaped ?? "",
    ),
  );
}

/** Each value `systemd()` in `scheduler.ts` quoted: backslash escapes, then `%%`. */
function systemdValues(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    (match[1] as string).replace(/\\(.)/g, "$1").replace(/%%/g, "%"),
  );
}

/** The service's `Environment=` lines, as the variables they set. */
function systemdEnvironment(service: string): Record<string, string> {
  return Object.fromEntries(
    [...service.matchAll(/^Environment=(".*")$/gm)].flatMap((match) => {
      const [entry = ""] = systemdValues(match[1] as string);
      const at = entry.indexOf("=");
      return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)]] : [];
    }),
  );
}

/** The service's and the timer's `Description=`, where each has one. */
function systemdDescriptions(
  service: string,
  timer: string,
): Pick<InstalledJob, "description" | "timerDescription"> {
  const description = /^Description=(.*)$/m.exec(service)?.[1];
  const timerDescription = /^Description=(.*)$/m.exec(timer)?.[1];
  return {
    ...(description === undefined ? {} : { description }),
    ...(timerDescription === undefined ? {} : { timerDescription }),
  };
}

function systemdJob(files: Record<string, string>): InstalledJob | null {
  const named = (suffix: string) =>
    Object.entries(files).find(([path]) => path.endsWith(suffix))?.[1];
  const service = named(".service");
  const timer = named(".timer");
  const exec =
    service === undefined ? undefined : /^ExecStart=(.*)$/m.exec(service)?.[1];
  if (service === undefined || timer === undefined || exec === undefined)
    return null;
  return {
    // ExecStart= reads `$$` as a literal dollar.
    command: systemdValues(exec).map((value) =>
      value.replace(/\$\$/g, () => "$"),
    ),
    env: systemdEnvironment(service),
    schedule: installedSchedule("systemd", timer),
    ...systemdDescriptions(service, timer),
  };
}

function unxml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function launchdJob(plist: string): InstalledJob | null {
  const program = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(
    plist,
  )?.[1];
  if (program === undefined) return null;
  const command = [...program.matchAll(/<string>(.*?)<\/string>/gs)].map(
    (match) => unxml(match[1] as string),
  );
  const variables =
    /<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(plist)?.[1] ??
    "";
  const env: Record<string, string> = {};
  for (const match of variables.matchAll(
    /<key>(.*?)<\/key><string>(.*?)<\/string>/gs,
  ))
    env[unxml(match[1] as string)] = unxml(match[2] as string);
  return { command, env, schedule: installedSchedule("launchd", plist) };
}

/** The crontab line marked `# <name>`: `<schedule> 'env' 'K=V'… <command>`. */
function cronJob(crontab: string, name: string): InstalledJob | null {
  const marker = ` # ${name}`;
  const line = crontab.split("\n").find((entry) => entry.endsWith(marker));
  if (line === undefined) return null;
  const fields = line.slice(0, -marker.length).split(" ");
  // Cron reads `\%` as a percent sign (`cronCommand` in scheduler.ts).
  const words = shellWords(fields.slice(5).join(" ").replace(/\\%/g, "%"));
  if (words?.[0] !== "env") return null;
  const env: Record<string, string> = {};
  let index = 1;
  for (; index < words.length; index++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(
      words[index] as string,
    );
    if (!match) break;
    env[match[1] as string] = match[2] as string;
  }
  return {
    command: words.slice(index),
    env,
    schedule: installedSchedule("cron", line),
  };
}

/**
 * Whether the snapshot holds any part of the job: a unit file, the plist or
 * the marked crontab line. A job that is present but not readable
 * (`readInstalledJob` null) is a broken installation, not an absent one.
 */
export function jobPresent(snapshot: SchedulerSnapshot): boolean {
  if (snapshot.scheduler === "cron")
    return (snapshot.files.crontab ?? "")
      .split("\n")
      .some((line) => line.endsWith(` # ${snapshot.spec.name}`));
  return Object.values(snapshot.files).some((text) => text !== null);
}

/** The job the snapshot found, as its install wrote it; null when none is installed or it cannot be read. */
export function readInstalledJob(
  snapshot: SchedulerSnapshot,
): InstalledJob | null {
  const present = Object.fromEntries(
    Object.entries(snapshot.files).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  if (snapshot.scheduler === "cron")
    return cronJob(present.crontab ?? "", snapshot.spec.name);
  if (snapshot.scheduler === "launchd") {
    const plist = Object.values(present)[0];
    return plist === undefined ? null : launchdJob(plist);
  }
  return systemdJob(present);
}

/**
 * What the `jig` command's script runs (`commandText` in `path-command.ts`):
 * the launcher's command and the deadline it sets. Null when the script is
 * not in that form.
 */
export function commandScriptCall(
  text: string,
): { command: string[]; deadlineSec?: number } | null {
  const windows = text.startsWith("@echo off");
  const deadline = windows
    ? /JIG_LAUNCHER_DEADLINE_SEC=(\d+)\r?$/m.exec(text)?.[1]
    : /JIG_LAUNCHER_DEADLINE_SEC:-(\d+)\}/.exec(text)?.[1];
  let command: string[];
  if (windows) {
    const line = text.split(/\r?\n/).find((entry) => entry.endsWith(" %*"));
    if (line === undefined) return null;
    // A batch file doubles a percent sign.
    command = [...line.matchAll(/"([^"]*)"/g)].map((match) =>
      (match[1] as string).replace(/%%/g, "%"),
    );
  } else {
    const line = /^exec (.*) "\$@"$/m.exec(text)?.[1];
    if (line === undefined) return null;
    const words = shellWords(line);
    if (words === null) return null;
    command = words;
  }
  return {
    command,
    ...(deadline === undefined ? {} : { deadlineSec: Number(deadline) }),
  };
}
