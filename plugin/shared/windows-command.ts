/** Windows executable lookup and the cmd wrapper needed by npm's batch shims. */
import { type SpawnOptions, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

interface WindowsCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  isFile?: (path: string) => boolean;
  readBatchSource?: (path: string) => string;
}
interface Command {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env)
    .sort()
    .find((key) => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

type WindowsCommandErrorCode =
  | "unsupported-argument"
  | "batch-too-large"
  | "unsupported-forwarding";

/** A launcher shape cmd cannot preserve safely; the caller reports a spawn failure. */
class WindowsCommandError extends Error {
  override name = "WindowsCommandError";
  readonly code: WindowsCommandErrorCode;
  constructor(code: WindowsCommandErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Resolve using the child's environment, not the driver's PATH or PATHEXT. */
export function resolveWindowsCommand(
  command: string,
  options: WindowsCommandOptions,
): string {
  const extensions = (envValue(options.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((ext) => /^\.[a-z0-9]+$/i.test(ext));
  const suffixes = win32.extname(command) ? ["", ...extensions] : extensions;
  const directories = /[\\/:]/.test(command)
    ? [options.cwd]
    : (envValue(options.env, "PATH") ?? "").split(";");
  const exists = options.isFile ?? isFile;
  for (const directory of directories) {
    const base = win32.resolve(
      options.cwd,
      directory.replace(/^"|"$/g, ""),
      command,
    );
    for (const suffix of suffixes) {
      const candidate = base + suffix;
      if (exists(candidate)) return candidate;
    }
  }
  // Preserve the native missing-executable error instead of guessing a shell.
  return command;
}

const META = /([()\][%!^"`<>&|;, *?])/g;
function escapeMeta(value: string): string {
  return value.replace(META, "^$1");
}

/** Quote for a Windows argv parser, then for cmd and the shim's %* reparse. */
function batchArgument(value: string, forwardsArguments: boolean): string {
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? slashes * 2 + 1 : slashes);
    quoted += character;
    slashes = 0;
  }
  quoted += "\\".repeat(slashes * 2) + '"';
  const escaped = escapeMeta(quoted);
  return forwardsArguments ? escapeMeta(escaped) : escaped;
}

/** The npm Node.js shim grammar; CALL or extra commands change expansion. */
const NPM_BATCH_LINES = [
  /^@echo off$/i,
  /^goto start$/i,
  /^:find_dp0$/i,
  /^set dp0=%~dp0$/i,
  /^exit \/b$/i,
  /^:start$/i,
  /^setlocal$/i,
  /^call :find_dp0$/i,
  /^$/,
  /^if exist "[^"\r\n]+" \($/i,
  /^ {2}set "_prog=[^"\r\n]+"$/i,
  /^\) else \($/i,
  /^ {2}set "_prog=[^"\r\n]+"$/i,
  /^\)$/,
  /^$/,
  /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & (?:set PATHEXT=%PATHEXT:;.JS;=;% & )?"%_prog%" {1,2}"%dp0%\\[^"\r\n]+" %\*$/i,
];

function isNpmBatchShim(source: string): boolean {
  const lines = source.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return (
    lines.length === NPM_BATCH_LINES.length &&
    NPM_BATCH_LINES.every((pattern, index) => pattern.test(lines[index] ?? ""))
  );
}

/** Native binaries stay shell-free; only .cmd/.bat files enter cmd.exe. */
export function windowsCommand(
  argv: string[],
  options: WindowsCommandOptions,
): Command {
  const command = resolveWindowsCommand(argv[0] ?? "", options);
  const args = argv.slice(1);
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args };
  if ([command, ...args].some((value) => /[\r\n\0]/.test(value))) {
    throw new WindowsCommandError(
      "unsupported-argument",
      "Windows batch launch cannot preserve a line break or NUL in an argument; pass multiline input through a file or stdin",
    );
  }
  // npm installs global shims outside node_modules/.bin as well. Its
  // generated _prog invocation forwards %*, requiring another escape layer.
  // Unknown forwarding wrappers can parse arguments arbitrarily: refuse them
  // instead of treating source text as a general batch-language parser.
  const readSource =
    options.readBatchSource ??
    ((file: string) => {
      if (statSync(file).size > 64 * 1024) {
        throw new WindowsCommandError(
          "batch-too-large",
          "Windows batch launcher is too large to inspect; launch its executable directly",
        );
      }
      return readFileSync(file, "utf8");
    });
  const source = readSource(command);
  const forwardsArguments = isNpmBatchShim(source);
  if (source.includes("%*") && !forwardsArguments) {
    throw new WindowsCommandError(
      "unsupported-forwarding",
      "Windows batch argument forwarding is supported only for npm-style _prog shims; launch the executable with its JavaScript entry point directly",
    );
  }
  const line = [
    escapeMeta(win32.normalize(command)),
    ...args.map((arg) => batchArgument(arg, forwardsArguments)),
  ].join(" ");
  return {
    command: envValue(options.env, "COMSPEC") ?? "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** Preserve argv on POSIX and native Windows binaries; adapt batch shims once. */
export function spawnCommand(
  argv: string[],
  options: SpawnOptions,
): ReturnType<typeof spawn> {
  const launch =
    process.platform === "win32"
      ? windowsCommand(argv, {
          cwd: String(options.cwd ?? process.cwd()),
          env: options.env ?? process.env,
        })
      : { command: argv[0] ?? "", args: argv.slice(1) };
  return spawn(launch.command, launch.args, {
    ...options,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
}
