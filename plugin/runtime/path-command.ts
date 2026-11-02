/**
 * The `jig` command on `PATH`: `~/.local/bin/jig` (`jig.cmd` on Windows), a
 * small script `jig install` writes and `jig uninstall --machine` removes. It
 * runs the launcher the installed jobs run, from its own copy under
 * `~/.local/state/jig/launcher/`, so removing a component's job never takes
 * the command with it. The launcher asks the agent tool recorded at install
 * which copy of the plugin is installed now and runs that copy's `jig.ts`,
 * so a plugin update reaches the command without a new install. The command
 * runs in the caller's own environment; only Bun and the agent tools are
 * recorded, by the absolute paths found at install.
 *
 * The script carries a marker line, so a file at that path that `jig install`
 * did not write is never replaced or removed.
 */
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { GcError } from "../shared/gc-error.ts";
import {
  installedScript,
  installLauncher,
  launcherCommand,
} from "./scheduler.ts";

/** The line that marks the script as one `jig install` wrote. */
const MARKER = "jig: written by jig install";

/** Where the command is written: `~/.local/bin/jig`, or `jig.cmd` on Windows. */
export function commandPath(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  return join(home, ".local", "bin", platform === "win32" ? "jig.cmd" : "jig");
}

/** The command's own copy of the launcher, outside every plugin release. */
function commandLauncherDirectory(home = homedir()): string {
  return join(home, ".local", "state", "jig", "launcher");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The script that runs `command` with the caller's arguments: a POSIX shell
 * script that `exec`s it, or a Windows batch file. A value the script cannot
 * carry (a line break, NUL, or a double quote in a batch file) is refused.
 */
export function commandText(
  command: readonly string[],
  platform: NodeJS.Platform = process.platform,
  deadlineSec?: number,
): string {
  if (command.some((value) => /[\r\n\0]/.test(value)))
    throw new GcError(
      "The jig command cannot name a path with a line break or NUL",
    );
  const purpose = "runs the installed jig plugin through its launcher";
  if (platform === "win32") {
    if (command.some((value) => value.includes('"')))
      throw new GcError(
        "The jig command cannot name a path with a double quote",
      );
    // A batch file reads a percent sign as a variable unless it is doubled.
    const quoted = command.map((value) => `"${value.replace(/%/g, "%%")}"`);
    const deadline =
      deadlineSec === undefined
        ? ""
        : `if not defined JIG_LAUNCHER_DEADLINE_SEC set JIG_LAUNCHER_DEADLINE_SEC=${deadlineSec}\r\n`;
    return `@echo off\r\nrem ${MARKER}; ${purpose}.\r\n${deadline}${quoted.join(" ")} %*\r\n`;
  }
  const deadline =
    deadlineSec === undefined
      ? ""
      : `JIG_LAUNCHER_DEADLINE_SEC="\${JIG_LAUNCHER_DEADLINE_SEC:-${deadlineSec}}"\nexport JIG_LAUNCHER_DEADLINE_SEC\n`;
  return `#!/bin/sh\n# ${MARKER}; ${purpose}.\n${deadline}exec ${command.map(shellQuote).join(" ")} "$@"\n`;
}

/**
 * The text of the file at `path`; null when the directory entry is absent.
 * An entry that is not a regular file (a symlink, even a dangling one, or a
 * directory) is not one `jig install` wrote and reads as empty text.
 */
function readOptional(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return "";
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Whether `directory` is one of `PATH`'s entries. */
function onPath(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const target = resolve(directory);
  return (env.PATH ?? "")
    .split(delimiter)
    .some((entry) => entry !== "" && resolve(entry) === target);
}

/**
 * Refuses a file at the command's path that `jig install` did not write,
 * before anything is installed, so a refused install leaves nothing behind.
 */
export function checkCommandPath(): void {
  const path = commandPath();
  const current = readOptional(path);
  if (current !== null && !current.includes(MARKER))
    throw new GcError(
      `${path} exists and jig install did not write it; move it aside, then run jig install again`,
    );
}

/**
 * The command's preview, then, with `confirm`, the launcher copy and the script.
 * `deadlineSec` is the longest run any component's job is granted: the
 * launcher stops a command at its collection default otherwise, which is
 * shorter than a dispatcher tick's budget.
 */
export function installCommand(options: {
  confirm: boolean;
  script: string;
  deadlineSec?: number;
}): number {
  checkCommandPath();
  const path = commandPath();
  const directory = commandLauncherDirectory();
  const text = commandText(
    launcherCommand(directory),
    process.platform,
    options.deadlineSec,
  );
  console.log(`The jig command (${path}):\n${text}`);
  if (!options.confirm) {
    console.log("Preview only. Repeat with --yes to write it.");
    return 0;
  }
  if (!installedScript(options.script))
    throw new GcError(
      "The jig command requires the installed plugin copy, outside every worktree",
    );
  installLauncher(directory);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o755 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`Wrote ${path}`);
  if (!onPath(dirname(path)))
    console.log(
      `${dirname(path)} is not on PATH: add it to your shell's PATH to run jig by name.`,
    );
  return 0;
}

/** The removal's preview, then, with `confirm`, the script and its launcher copy. */
export function removeCommand(options: { confirm: boolean }): number {
  const path = commandPath();
  const current = readOptional(path);
  const ours = current?.includes(MARKER) === true;
  console.log(
    current === null
      ? `The jig command: ${path} does not exist`
      : ours
        ? `The jig command: ${path} is removed`
        : `The jig command: ${path} was not written by jig install and stays`,
  );
  if (!options.confirm) {
    console.log("Preview only. Repeat with --yes to remove it.");
    return 0;
  }
  if (ours) rmSync(path, { force: true });
  rmSync(commandLauncherDirectory(), { recursive: true, force: true });
  if (ours) console.log(`Removed ${path}`);
  return 0;
}
