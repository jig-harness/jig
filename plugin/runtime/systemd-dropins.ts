/**
 * A systemd job as systemd runs it: the unit file `jobFiles` in
 * `scheduler.ts` writes, with the drop-ins a host adds beside it
 * (`<unit>.d/*.conf`) applied. A host may replace the job's `ExecStart=` with
 * a wrapper that resolves a credential and then runs the same command, or add
 * `Environment=` lines; whoever runs the job's command outside systemd (the
 * wake waiter, `dispatch/lib/wake-tick.ts`) must run that wrapper, never the
 * base file's command alone.
 *
 * Only what a drop-in can do to the command and its environment is read:
 * `ExecStart=` (an empty one clears the list, as systemd reads it) and
 * `Environment=` (an empty one clears the variables). A drop-in that changes
 * the process another way (an environment file, a credential, a command run
 * before it, another user or directory), or writes the command in a form this
 * reader does not take (a variable, a specifier it does not know, a prefix
 * other than `-`), is `unsupported`, with the reason: a command that cannot be
 * reproduced is not replaced by a degraded one. `jig upgrade` rewrites the
 * base unit from `installed-job.ts`, which reads the base file alone.
 */
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { attempt, failed, ok, type Outcome } from "../shared/outcome.ts";
import { run } from "../shared/proc.ts";

/** One drop-in file: where it is and what it says. */
export interface DropIn {
  path: string;
  text: string;
}

/** What `%` specifiers in a unit expand to, for the user manager. */
export interface Specifiers {
  home: string;
  user: string;
  uid: string;
  /** The unit's full name, `jig-dispatch.service`. */
  unit: string;
  runtimeDir?: string;
}

/** The job's command and environment as systemd runs them. */
export interface EffectiveJob {
  command: string[];
  env: Record<string, string>;
  /** Whether a drop-in replaced the command or changed the environment. */
  changed: boolean;
  /** Variables the base unit set that a drop-in cleared: a process that inherits more must not keep them. */
  unset: string[];
}

/**
 * `[Service]` keys a drop-in may set without changing what the job's process
 * runs or sees: the ones this reader applies, and settings about the unit's
 * bookkeeping. Every other key (a sandbox, a privilege, a user, a directory,
 * a credential, a command run around the job, a resource limit) is applied by
 * systemd and not by a plain child process, so it is refused; a list of the
 * keys to refuse would miss each directive systemd adds.
 */
const REPRODUCED = new Set([
  "Type",
  "ExecStart",
  "Environment",
  "SyslogIdentifier",
  "SyslogFacility",
  "SyslogLevel",
  "TimeoutStartSec",
  "TimeoutStopSec",
  "TimeoutSec",
  "RemainAfterExit",
]);

/** Directives that hold a list, which an empty assignment clears, as systemd reads it; any other keeps its earlier value. */
const RESETTABLE =
  /^(Exec\w+|EnvironmentFile|UnsetEnvironment|PassEnvironment|\w*Credential\w*|\w*Paths|TemporaryFileSystem|SystemCall(Filter|Architectures|Log)|CapabilityBoundingSet|AmbientCapabilities|Restrict(AddressFamilies|FileSystems)|IPAddress(Allow|Deny)|DeviceAllow|SupplementaryGroups|BindPaths)$/;

/** Whether `key` changes the process in a way this reader does not reproduce. */
function unreproduced(key: string): boolean {
  return !REPRODUCED.has(key);
}

/** A variable name systemd accepts: letters, digits and underscores, not starting with a digit. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Whether `value` holds a control character, other than a tab, which systemd refuses in a variable's value. */
function unprintable(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code === 0x7f || (code < 0x20 && code !== 0x09);
  });
}

/** The specifiers' current values for the user manager running `unit`. */
export function userSpecifiers(unit: string): Specifiers {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return {
    home: homedir(),
    user: userInfo().username,
    uid: String(process.getuid?.() ?? ""),
    unit,
    ...(runtimeDir ? { runtimeDir } : {}),
  };
}

function expandSpecifiers(
  word: string,
  specifiers: Specifiers,
): Outcome<string, "unsupported"> {
  const prefix = specifiers.unit.replace(/\.[^.]+$/, "");
  const values: Record<string, string | undefined> = {
    "%": "%",
    h: specifiers.home,
    u: specifiers.user,
    U: specifiers.uid,
    n: specifiers.unit,
    N: prefix,
    p: prefix,
    t: specifiers.runtimeDir,
  };
  let unknown: string | null = null;
  const expanded = word.replace(/%(.?)/g, (_, letter: string) => {
    const value = values[letter];
    if (value === undefined) unknown ??= `%${letter}`;
    return value ?? "";
  });
  return unknown === null
    ? ok(expanded)
    : failed("unsupported", `the specifier ${unknown} is not one it expands`);
}

/** The C escapes systemd reads in a value that name one character; a numeric one (`\x41`, `\101`, `\u0041`) is refused. */
const ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  s: " ",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

/** What the word scanner holds between characters. */
interface Scan {
  words: string[];
  word: string | null;
  quote: string | null;
}

/** One character of a value, outside an escape: the scanner's next state. */
function scanChar(scan: Scan, char: string): void {
  if (scan.quote !== null) {
    if (char === scan.quote) scan.quote = null;
    else scan.word = (scan.word ?? "") + char;
  } else scanUnquoted(scan, char);
}

function scanUnquoted(scan: Scan, char: string): void {
  if (char === '"' || char === "'") {
    scan.quote = char;
    scan.word ??= "";
  } else if (/\s/.test(char)) {
    if (scan.word !== null) scan.words.push(scan.word);
    scan.word = null;
  } else scan.word = (scan.word ?? "") + char;
}

/** A value split into words by whitespace, quotes and C escapes, before specifiers. */
function splitWords(value: string): Outcome<string[], "unsupported"> {
  const scan: Scan = { words: [], word: null, quote: null };
  for (let at = 0; at < value.length; at++) {
    const char = value[at] as string;
    if (char !== "\\" || at + 1 >= value.length) {
      scanChar(scan, char);
      continue;
    }
    const next = value[++at] as string;
    const escaped = ESCAPES[next];
    if (escaped === undefined)
      return failed("unsupported", `the escape \\${next} is not one it reads`);
    scan.word = (scan.word ?? "") + escaped;
  }
  if (scan.quote !== null) return failed("unsupported", "a quote is left open");
  if (scan.word !== null) scan.words.push(scan.word);
  return ok(scan.words);
}

/**
 * The words of a unit's value: separated by whitespace, each quoted in
 * double or single quotes or not, a backslash starting a C escape; then
 * each word's specifiers expanded; unsupported for a quote left open, an
 * escape it does not read or a specifier it does not know.
 */
export function unitWords(
  value: string,
  specifiers: Specifiers,
): Outcome<string[], "unsupported"> {
  const words = splitWords(value);
  if (!words.ok) return words;
  const expanded: string[] = [];
  for (const raw of words.value) {
    const one = expandSpecifiers(raw, specifiers);
    if (!one.ok) return one;
    expanded.push(one.value);
  }
  return ok(expanded);
}

/** An `ExecStart=` value's argument list: its `-` prefix dropped, its `$$` read as a dollar; unsupported for a variable or another prefix. */
function execWords(
  value: string,
  specifiers: Specifiers,
): Outcome<string[], "unsupported"> {
  const words = unitWords(value, specifiers);
  if (!words.ok) return words;
  const [first, ...rest] = words.value;
  if (first === undefined)
    return failed("unsupported", "the command has no program");
  // `-` only says a failed exit is not the unit's failure.
  const program = first.startsWith("-") ? first.slice(1) : first;
  if (/^[@:+!]/.test(program))
    return failed(
      "unsupported",
      `the command's prefix ${program[0]} is not one it reproduces`,
    );
  const argv = [program, ...rest];
  if (argv.some((arg) => /\$(?!\$)/.test(arg.replace(/\$\$/g, ""))))
    return failed(
      "unsupported",
      "the command names a variable, which systemd expands from its own environment",
    );
  return ok(argv.map((arg) => arg.replace(/\$\$/g, () => "$")));
}

/**
 * A unit file's lines as systemd reads them: a line ending in a backslash
 * continued on the next, a comment line inside a continuation skipped, and
 * comment and empty lines left out.
 */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let continued: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith(";")) continue;
    const joined: string = continued === null ? line : `${continued} ${line}`;
    if (line.endsWith("\\")) continued = joined.slice(0, -1);
    else {
      continued = null;
      if (joined !== "") out.push(joined);
    }
  }
  if (continued !== null && continued.trim() !== "") out.push(continued);
  return out;
}

/** A unit file's assignments, section by section. */
function assignments(
  text: string,
): Array<{ section: string; key: string; value: string }> {
  const out: Array<{ section: string; key: string; value: string }> = [];
  let section = "";
  for (const line of logicalLines(text)) {
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1] as string;
      continue;
    }
    const at = line.indexOf("=");
    if (at <= 0) continue;
    out.push({
      section,
      key: line.slice(0, at).trim(),
      value: line.slice(at + 1).trim(),
    });
  }
  return out;
}

/** What the drop-ins have made of the job so far. */
interface JobState {
  commands: string[][];
  env: Record<string, string>;
  changed: boolean;
  /** Directives this reader does not reproduce that a drop-in set to a value, key to the drop-in that set it; a later empty assignment does not lift them. */
  active: Map<string, string>;
}

/** An `Environment=` value's variables set in `state`; the reason it is not reproducible. */
function applyEnvironment(
  state: JobState,
  value: string,
  specifiers: Specifiers,
): string | null {
  state.changed = true;
  if (value === "") {
    state.env = {};
    return null;
  }
  const words = unitWords(value, specifiers);
  if (!words.ok) return words.failure.reason;
  for (const word of words.value) {
    const at = word.indexOf("=");
    const name = at <= 0 ? "" : word.slice(0, at);
    if (!VARIABLE_NAME.test(name))
      return `Environment= sets no valid variable name: ${name || "(none)"}`;
    if (unprintable(word.slice(at + 1)))
      return `Environment= sets ${name} to a value with a control character`;
    state.env[name] = word.slice(at + 1);
  }
  return null;
}

/** One `[Service]` assignment of the drop-in at `path` applied to `state`; the reason it is not reproducible. */
function applyAssignment(
  state: JobState,
  assignment: { key: string; value: string },
  path: string,
  specifiers: Specifiers,
): string | null {
  const { key, value } = assignment;
  if (unreproduced(key)) {
    // An empty assignment clears a list and is ignored by a scalar, which keeps its earlier value.
    if (value !== "") state.active.set(key, path);
    else if (RESETTABLE.test(key)) state.active.delete(key);
  } else if (key === "Environment")
    return applyEnvironment(state, value, specifiers);
  else if (key === "ExecStart") {
    state.changed = true;
    if (value === "") state.commands = [];
    else {
      const argv = execWords(value, specifiers);
      if (!argv.ok) return argv.failure.reason;
      state.commands.push(argv.value);
    }
  }
  return null;
}

/**
 * The base job with `dropIns` applied in their order: the command systemd
 * runs and the environment it runs it with; `unsupported` with the reason
 * when a drop-in changes the job in a way this reader cannot reproduce.
 */
export function effectiveJob(
  base: { command: string[]; env: Record<string, string> },
  dropIns: readonly DropIn[],
  specifiers: Specifiers,
): Outcome<EffectiveJob, "unsupported"> {
  const state: JobState = {
    commands: [base.command],
    env: { ...base.env },
    changed: false,
    active: new Map(),
  };
  for (const dropIn of dropIns)
    for (const assignment of assignments(dropIn.text)) {
      if (assignment.section !== "Service") continue;
      const reason = applyAssignment(
        state,
        assignment,
        dropIn.path,
        specifiers,
      );
      if (reason !== null)
        return failed("unsupported", `the drop-in ${dropIn.path}: ${reason}`);
    }
  for (const [key, path] of state.active)
    return failed(
      "unsupported",
      `the drop-in ${path}: ${key}= is not reproduced outside systemd`,
    );
  const [command, ...more] = state.commands;
  if (command === undefined)
    return failed("unsupported", "the drop-ins leave the job no command");
  if (more.length > 0)
    return failed(
      "unsupported",
      "the drop-ins give the job more than one command",
    );
  const { env, changed } = state;
  const unset = Object.keys(base.env).filter((name) => !(name in env));
  return ok({ command, env, changed, unset });
}

/**
 * The drop-ins systemd applies to the user unit `unit`, in its order, as
 * `systemctl show` names them (`DropInPaths`), each file read; or why they
 * cannot be read.
 */
export async function readDropIns(
  unit: string,
): Promise<Outcome<DropIn[], "unreadable">> {
  const command = [
    "systemctl",
    "--user",
    "show",
    unit,
    "--property=NeedDaemonReload",
    "--property=DropInPaths",
  ];
  const result = await run(command, { timeoutSec: 30 });
  if (result.timedOut || result.spawnFailed || result.code !== 0)
    return failed(
      "unreadable",
      `${command.join(" ")} did not answer: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  const properties = new Map(
    result.stdout
      .split("\n")
      .map(
        (line) =>
          [
            line.slice(0, line.indexOf("=")),
            line.slice(line.indexOf("=") + 1),
          ] as const,
      ),
  );
  // The files on disk are the loaded configuration only while the manager has not been told of an edit.
  if (properties.get("NeedDaemonReload") !== "no")
    return failed(
      "unreadable",
      `${unit}'s files changed since systemd loaded them (or whether they did could not be read), so the loaded drop-ins are not the files on disk`,
    );
  const out: DropIn[] = [];
  // The paths are one space-separated line: a space inside a directory name is told from the separator by the `/` that starts the next path.
  for (const path of (properties.get("DropInPaths") ?? "")
    .split(/\s+(?=\/)/)
    .map((one) => one.trim())
    .filter(Boolean)) {
    const text = attempt(
      "unreadable",
      `the drop-in ${path} does not read`,
      () => readFileSync(path, "utf8"),
    );
    if (!text.ok) return text;
    out.push({ path, text: text.value });
  }
  return ok(out);
}
