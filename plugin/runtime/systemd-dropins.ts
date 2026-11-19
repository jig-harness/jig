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
}

type Unsupported = Outcome<never, "unsupported">;

/** `[Service]` keys that change what the job's process runs or sees in a way this reader does not reproduce. */
const UNREPRODUCED = new Set([
  "EnvironmentFile",
  "UnsetEnvironment",
  "PassEnvironment",
  "ExecCondition",
  "ExecStartPre",
  "LoadCredential",
  "LoadCredentialEncrypted",
  "SetCredential",
  "SetCredentialEncrypted",
  "ImportCredential",
  "User",
  "Group",
  "WorkingDirectory",
  "RootDirectory",
]);

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
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let at = 0; at < value.length; at++) {
    const char = value[at] as string;
    if (char === "\\" && at + 1 < value.length) {
      const next = value[++at] as string;
      const escaped = ESCAPES[next];
      if (escaped === undefined)
        return failed(
          "unsupported",
          `the escape \\${next} is not one it reads`,
        );
      word = (word ?? "") + escaped;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else word = (word ?? "") + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote !== null) return failed("unsupported", "a quote is left open");
  if (word !== null) words.push(word);
  const expanded: string[] = [];
  for (const raw of words) {
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
  let commands: string[][] = [base.command];
  let env = { ...base.env };
  let changed = false;
  const refuse = (path: string, reason: string): Unsupported =>
    failed("unsupported", `the drop-in ${path}: ${reason}`);
  for (const dropIn of dropIns) {
    for (const { section, key, value } of assignments(dropIn.text)) {
      if (section !== "Service") continue;
      if (UNREPRODUCED.has(key))
        return refuse(dropIn.path, `${key}= is not reproduced outside systemd`);
      if (key === "ExecStart") {
        changed = true;
        if (value === "") {
          commands = [];
          continue;
        }
        const argv = execWords(value, specifiers);
        if (!argv.ok) return refuse(dropIn.path, argv.failure.reason);
        commands.push(argv.value);
      } else if (key === "Environment") {
        changed = true;
        if (value === "") {
          env = {};
          continue;
        }
        const words = unitWords(value, specifiers);
        if (!words.ok) return refuse(dropIn.path, words.failure.reason);
        for (const word of words.value) {
          const at = word.indexOf("=");
          if (at <= 0)
            return refuse(
              dropIn.path,
              `Environment= sets no variable: ${word}`,
            );
          env[word.slice(0, at)] = word.slice(at + 1);
        }
      }
    }
  }
  const [command, ...more] = commands;
  if (command === undefined)
    return failed("unsupported", "the drop-ins leave the job no command");
  if (more.length > 0)
    return failed(
      "unsupported",
      "the drop-ins give the job more than one command",
    );
  return ok({ command, env, changed });
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
    "--property=DropInPaths",
    "--value",
  ];
  const result = await run(command, { timeoutSec: 30 });
  if (result.timedOut || result.spawnFailed || result.code !== 0)
    return failed(
      "unreadable",
      `${command.join(" ")} did not answer: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  const out: DropIn[] = [];
  for (const path of result.stdout.split(/\s+/).filter(Boolean)) {
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
