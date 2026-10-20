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
  | "unsupported-forwarding"
  | "command-too-long";

/** A launcher shape cmd cannot preserve safely; the caller reports a spawn failure. */
class WindowsCommandError extends Error {
  override name = "WindowsCommandError";
  readonly code: WindowsCommandErrorCode;
  constructor(code: WindowsCommandErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The PATHEXT types this module can launch: native images and batch files. */
const LAUNCHABLE = /^\.(com|exe|bat|cmd)$/i;

/**
 * Resolve using the child's environment, not the driver's PATH or PATHEXT.
 * A bare name searches cwd before PATH, as native Windows spawning does,
 * unless NoDefaultCurrentDirectoryInExePath is set. Empty PATH components are
 * skipped, so an absent PATH or a stray `;` never reintroduces cwd.
 */
export function resolveWindowsCommand(
  command: string,
  options: WindowsCommandOptions,
): string {
  const extensions = (envValue(options.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((ext) => LAUNCHABLE.test(ext));
  const suffixes = win32.extname(command) ? ["", ...extensions] : extensions;
  const searchesCwd =
    envValue(options.env, "NODEFAULTCURRENTDIRECTORYINEXEPATH") === undefined;
  const pathDirectories = (envValue(options.env, "PATH") ?? "")
    .split(";")
    .map((directory) => directory.replace(/^"|"$/g, ""))
    .filter((directory) => directory !== "");
  const directories = /[\\/:]/.test(command)
    ? [options.cwd]
    : [...(searchesCwd ? [options.cwd] : []), ...pathDirectories];
  const exists = options.isFile ?? isFile;
  for (const directory of directories) {
    const base = win32.resolve(options.cwd, directory, command);
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

/** A shebang argument npm copies into the shim; quotes or cmd syntax would reparse %*. */
const SHIM_ARGUMENT = String.raw`[^\s"%^&|<>()!]+`;
/**
 * A path in the shim. The only variable reference it may hold is %dp0%, so
 * every reference the grammar admits is one the length estimate expands.
 */
const SHIM_PATH = String.raw`(?:[^"%\n]|%dp0%)+`;

/**
 * The npm Node.js shim grammar: the shebang's interpreter arguments may sit
 * between _prog and the entry point, and the PATHEXT edit sits either in the
 * ELSE branch or on the final line. CALL, extra commands, environment
 * declarations from `env -S VAR=value` and variable references other than
 * %dp0% in a path change expansion and are refused.
 */
const NPM_BATCH_SHIM = new RegExp(
  `^${[
    "@echo off",
    "goto start",
    ":find_dp0",
    "set dp0=%~dp0",
    "exit /b",
    ":start",
    "setlocal",
    "call :find_dp0",
    "",
    String.raw`if exist "${SHIM_PATH}" \(`,
    String.raw` {2}set "_prog=${SHIM_PATH}"`,
    String.raw`\) else \(`,
    String.raw` {2}set "_prog=${SHIM_PATH}"(?:\n {2}set PATHEXT=%PATHEXT:;\.JS;=;%)?`,
    String.raw`\)`,
    "",
    String.raw`endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & (?:set PATHEXT=%PATHEXT:;\.JS;=;% & )?"%_prog%" (?:(?:${SHIM_ARGUMENT} )+| ?)"%dp0%\\[^"%\n]+" %\*`,
  ].join("\n")}$`,
  "i",
);

function isNpmBatchShim(source: string): boolean {
  return NPM_BATCH_SHIM.test(source.replace(/\r\n/g, "\n").trimEnd());
}

/** cmd.exe's maximum command-line length, in characters, after expansion too. */
const CMD_LINE_LIMIT = 8191;
/** The COMSPEC cmd.exe sets for itself when the child environment has none. */
const DEFAULT_COMSPEC = String.raw`C:\Windows\System32\cmd.exe`;

/**
 * The longest line of a recognized npm shim once cmd expands it. Every
 * variable the grammar admits is substituted at its upper bound: PATHEXT
 * before the `;.JS;` edit and the longer `_prog` branch. %* is the argument
 * text with the outer cmd parse's escape layer removed, as the shim sees it.
 */
function expandedShimLength(
  source: string,
  batchFile: string,
  argumentText: string,
  env: NodeJS.ProcessEnv,
): number {
  const dp0 = `${win32.dirname(batchFile)}\\`;
  const programs = [...source.matchAll(/set "_prog=([^"\n]+)"/gi)].map(
    // A callback, so `$` sequences in the directory stay literal.
    (match) => (match[1] ?? "").replace(/%dp0%/gi, () => dp0),
  );
  const values: Record<string, string> = {
    "%~DP0": dp0,
    "%DP0%": dp0,
    "%_PROG%": programs.reduce((a, b) => (b.length > a.length ? b : a), ""),
    "%COMSPEC%": envValue(env, "COMSPEC") ?? DEFAULT_COMSPEC,
    "%PATHEXT%": envValue(env, "PATHEXT") ?? "",
    "%*": argumentText,
  };
  return Math.max(
    ...source.split(/\r?\n/).map(
      (line) =>
        // One pass, so an expanded value is never itself re-expanded.
        line.replace(
          /%~dp0|%dp0%|%_prog%|%comspec%|%pathext(?::[^%\n]*)?%|%\*/gi,
          (variable) =>
            values[variable.toUpperCase().replace(/:.*%$/, "%")] ?? variable,
        ).length,
    ),
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
  const batchFile = win32.normalize(command);
  const escapedArgs = args.map((arg) => batchArgument(arg, forwardsArguments));
  // The outer parse strips one caret layer before the shim expands %*.
  const argumentText = args.map((arg) => batchArgument(arg, false)).join(" ");
  const line = [escapeMeta(batchFile), ...escapedArgs].join(" ");
  // The shim re-expands %* behind its own runtime and entry-point paths.
  const shimLength = forwardsArguments
    ? expandedShimLength(source, batchFile, argumentText, options.env)
    : 0;
  if (
    Math.max(`/d /s /v:off /c "${line}"`.length, shimLength) > CMD_LINE_LIMIT
  ) {
    throw new WindowsCommandError(
      "command-too-long",
      `Windows batch launch exceeds cmd.exe's ${CMD_LINE_LIMIT}-character command line once escaped; launch the executable directly or pass long input through a file or stdin`,
    );
  }
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
