#!/usr/bin/env bun
// Cache-mount coverage: a container build whose dependency store lives on a
// cache mount carries that mount on every step that reads the store.
//
// The problem it catches. A build-time cache mount (BuildKit's
// `RUN --mount=type=cache,target=<path>`) exists only for the one RUN that
// declares it; nothing of it is committed to the image. A stage that points
// the package manager's store at the mount's path (a stage-level environment
// variable, which every later process of the stage inherits) therefore needs
// the mount on EVERY RUN that invokes the package manager: the install step
// is the obvious one, but a build step whose lifecycle script calls the
// package manager again reads the same store, and without the mount it finds
// an empty directory. Which steps read the store is not a property of the
// Dockerfile (it depends on scripts in other files), so the rule is the only
// one that is decidable from the Dockerfile alone: mount it on all of them.
//
// The rules, each on the stage's package-manager invocations:
//   * cache-mount-missing: the stage's store is pinned to a path by
//     `ENV <store-env>=<path>` or by a build argument `ARG <store-env>` whose
//     value the build supplies (`--build-arg`), and a RUN that invokes the
//     command does not mount a `type=cache` mount at that path. A command's
//     own `<store-env>=<path>` prefix pins the store for that command and for
//     every command it runs (a `-c` body, an `eval`).
//   * cache-id-mismatch: two RUNs of one stage lineage (a stage and the
//     stages built FROM it) mount a store's path as different caches (a
//     mount's `id`, which defaults to its target), so one reads a store the
//     other filled. Every store a RUN's invocations read is checked, the
//     stage's and any a command sets for itself. Unrelated stages may keep
//     their own caches on the same path.
//   * store-flag: a RUN pins the store with the per-command flag
//     (`--store-dir` for pnpm) instead of the stage-level variable. A flag
//     binds one process; a child process the command spawns falls back to
//     the default location, so two steps of one stage read different stores.
//
// A stage inherits the pins, and the SHELL, of the stage it builds FROM; ENV
// outranks ARG for the same name. A stage that pins nothing is outside the
// mount rules (its mounts, if any, are the reviewer's).
//
// Fail closed. Input the check cannot read never passes (exit 2): no
// Dockerfile, an unreadable or empty one, an unfinished continuation, a RUN
// option other than --mount, --network and --security, a RUN with a heredoc
// body, an unterminated quote or substitution, a RUN whose command is an
// expansion (`$PM install`), an interpreter's `-c` body that is not a
// literal, a SHELL that is not a POSIX shell, a pin whose value is an
// expansion or a build argument whose value the build command was not given,
// a cache mount whose target or id is an expansion, a FROM whose image is an
// expansion while a stage pins the store, or an `escape=` directive other
// than the backslash, a wrapper option (of env, sudo, nice, timeout, exec,
// command, time) the reader does not model, a SHELL with an operand among
// its options, a pin of several words in ENV's one-pair form, and an
// argument of the command whose expansion can pass the store flag (an
// unquoted expansion, or one not after a literal that rules the flag out:
// `--filter "app-$P"` is read, `"$P"` is not). In a pinned stage, so is a RUN
// that reassigns, exports or clears the store's variable, a shell that reads
// its script from standard input, or a call of a function the RUN defines
// with a store other than the one its body was read with. A spelling the tokenizer does not model is a reason to exit
// 2, never a reason to pass.
//
// Exit codes: 0 every invocation is covered, 1 at least one finding, 2 usage
// or input error.
//
// Usage:
//   check-cache-mounts.ts [--command pnpm] [--store-env npm_config_store_dir]
//     [--store-flag --store-dir] [--build-arg NAME=VALUE]... <Dockerfile>...
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { cli, optionValue } from "../../../../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../../../lib/findings.ts";

const GATE = "check-cache-mounts";
const usage =
  "usage: check-cache-mounts.ts [--command <name>] [--store-env <VAR>] [--store-flag <--flag>] [--build-arg NAME=VALUE]... <Dockerfile>...";

export interface Options {
  /** The package manager's command name, as it appears in a RUN. */
  command: string;
  /** The stage-level variable that pins the store's path. */
  storeEnv: string;
  /** The per-command flag that pins the store for one process only. */
  storeFlag: string;
  /** The build arguments the build passes (`--build-arg NAME=VALUE`). */
  buildArgs: Map<string, string>;
}

export const DEFAULTS: Options = {
  command: "pnpm",
  storeEnv: "npm_config_store_dir",
  storeFlag: "--store-dir",
  buildArgs: new Map(),
};

/** Thrown for input the check cannot read; the boundary turns it into exit 2. */
export class Unreadable extends Error {}

interface Instruction {
  keyword: string;
  args: string;
  line: number;
}

/** One folded instruction; throw unless it starts with a keyword. */
function instructionOf(
  buffer: string,
  start: number,
  file: string,
): Instruction {
  const m = /^\s*([A-Za-z]+)\s*(.*)$/s.exec(buffer);
  if (!m)
    throw new Unreadable(`${file}:${start}: not an instruction: ${buffer}`);
  return {
    keyword: (m[1] ?? "").toUpperCase(),
    args: (m[2] ?? "").trim(),
    line: start,
  };
}

/** The instructions of a Dockerfile, continuation lines joined as Docker
 * joins them (the backslash and the line break removed), comments and blank
 * lines inside them dropped, each with the line it starts on. */
export function instructions(text: string, file: string): Instruction[] {
  const directive = /^#\s*escape\s*=\s*(\S)/im.exec(text.slice(0, 200));
  if (directive && directive[1] !== "\\")
    throw new Unreadable(
      `${file}: escape directive '${directive[1]}' is not read`,
    );
  const out: Instruction[] = [];
  let buffer = "",
    start = 0,
    open = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\uFEFF/, "");
    // A comment, also inside a continuation, and a blank line are skipped.
    if (/^\s*#/.test(line) || !line.trim()) return;
    if (!open) start = index + 1;
    const continues = /\\\s*$/.test(line);
    buffer += continues ? line.replace(/\\\s*$/, "") : line;
    open = continues;
    if (open) return;
    out.push(instructionOf(buffer, start, file));
    buffer = "";
  });
  if (open)
    throw new Unreadable(
      `${file}:${start}: the file ends inside a continuation line`,
    );
  return out;
}

/** A word of shell text, and whether any part of it is an expansion. */
export interface Word {
  text: string;
  expands: boolean;
  /** The literal text before the word's first expansion. */
  lead?: string;
  /** Whether an expansion in it is unquoted, so it can split into words. */
  splits?: boolean;
  /** Whether any part of it is quoted or escaped, so it is no reserved word
   * or function name. */
  quoted?: boolean;
}

/**
 * The command lists of a shell line, each a list of words. Quotes and
 * backslashes are honoured; `;`, `|`, `&`, newlines and parentheses end a
 * list. A command substitution (`$(…)` or backquotes, quoted or not) is one
 * expanding word of the command around it, and its own commands are lists
 * of their own, after the outer ones.
 */
export function segments(shell: string, where = "shell text"): Word[][] {
  return scanShell(shell, where, []);
}

/** The command lists of a shell text, as `segments` reads them; the names of
 * the functions it defines are added to `defined`. */
function scanShell(shell: string, where: string, defined: string[]): Word[][] {
  const scan: Scan = {
    shell,
    where,
    i: 0,
    lists: [[]],
    nested: [],
    word: null,
    quote: null,
    defined,
  };
  for (; scan.i < shell.length; scan.i++) {
    const ch = shell[scan.i] ?? "";
    const next = shell[scan.i + 1];
    if (scan.quote === "'") scanSingle(scan, ch);
    else if (scan.quote === '"') scanDouble(scan, ch, next);
    else scanBare(scan, ch, next);
  }
  if (scan.quote)
    throw new Unreadable(`${where}: an unterminated ${scan.quote} quote`);
  end(scan);
  return [...scan.lists, ...scan.nested].filter((list) => list.length > 0);
}

/** The scanner's state: the lists so far, the substitutions' lists, the word
 * being read, the quote open. */
interface Scan {
  shell: string;
  where: string;
  i: number;
  lists: Word[][];
  nested: Word[][];
  word: Word | null;
  quote: "'" | '"' | null;
  /** The names of the functions the text defines. */
  defined: string[];
}

/** Close the word being read, if any, into the current list; record the
 * name a `function name` definition gives. */
function end(scan: Scan): void {
  const list = scan.lists[scan.lists.length - 1];
  if (scan.word) list?.push(scan.word);
  scan.word = null;
  if (!list) return;
  const k = pastReserved(list);
  if (list.length - k === 2 && isLiteral(list[k], "function"))
    defineName(scan, list[k + 1]);
}

/** The index of a list's first word after its leading reserved words and
 * the shell's `time` keyword (with its `-p`), which may precede a
 * definition. A `time` with nothing after it is the word itself. */
function pastReserved(list: Word[]): number {
  let k = 0;
  for (;;) {
    const word = list[k];
    if (!word || word.quoted || word.expands) return k;
    if (RESERVED.has(word.text)) k++;
    else if (word.text === "time" && list[k + 1])
      k += isLiteral(list[k + 1], "-p") ? 2 : 1;
    else return k;
  }
}

/** Whether a word is the unquoted literal `text`. */
const isLiteral = (word: Word | undefined, text: string): boolean =>
  word !== undefined && !word.quoted && !word.expands && word.text === text;

/** Record a function name, when the word is one: unquoted and literal. */
function defineName(scan: Scan, word: Word | undefined): void {
  if (word && !word.quoted && !word.expands && FUNCTION_NAME.test(word.text))
    scan.defined.push(word.text);
}

/** A `name()` definition: a `(` closed by `)` with only blanks between,
 * after a command list that is the name alone (or `function name`). */
function defineByParens(scan: Scan): void {
  if (!/^\(\s*\)/.test(scan.shell.slice(scan.i))) return;
  const list = scan.lists[scan.lists.length - 1] ?? [];
  const k = pastReserved(list);
  if (list.length - k === 1) defineName(scan, list[k]);
}

/** Append text to the word being read, opening one if none is. An
 * expansion outside quotes is one that splits. */
function add(scan: Scan, ch: string, expands = false): void {
  scan.word ??= { text: "", expands: false };
  if (expands && !scan.word.expands) scan.word.lead = scan.word.text;
  if (expands && scan.quote === null) scan.word.splits = true;
  scan.word.text += ch;
  scan.word.expands ||= expands;
}

/** A command substitution starting at the scanner's position (`$(` or a
 * backquote): its commands become lists of their own, the word expands. */
function substitution(scan: Scan): void {
  const backquote = scan.shell[scan.i] === "`";
  const close = backquote
    ? closingBackquote(scan.shell, scan.i + 1)
    : matchingParen(scan.shell, scan.i + 1);
  if (close < 0)
    throw new Unreadable(`${scan.where}: an unterminated command substitution`);
  const body = scan.shell.slice(scan.i + (backquote ? 1 : 2), close);
  if (/(^|[\s;&|(])case\s/.test(body))
    throw new Unreadable(
      `${scan.where}: a case inside a command substitution is not read`,
    );
  scan.nested.push(...scanShell(body, scan.where, scan.defined));
  add(scan, "", true);
  scan.i = close;
}

/** Inside single quotes: everything is literal until the closing quote. */
function scanSingle(scan: Scan, ch: string): void {
  if (ch === "'") scan.quote = null;
  else add(scan, ch);
}

/** Inside double quotes: escapes, substitutions and expansions are read. */
function scanDouble(scan: Scan, ch: string, next: string | undefined): void {
  if (ch === '"') scan.quote = null;
  else if (ch === "\\" && next !== undefined)
    add(scan, scan.shell[++scan.i] ?? "");
  else if ((ch === "$" && next === "(") || ch === "`") substitution(scan);
  else add(scan, ch, ch === "$");
}

/** A backslash outside quotes: a continuation, or the next character literal. */
function scanEscape(scan: Scan, ch: string, next: string | undefined): boolean {
  if (ch !== "\\" || next === undefined) return false;
  if (next === "\n")
    scan.i++; // a continuation
  else {
    add(scan, scan.shell[++scan.i] ?? "");
    if (scan.word) scan.word.quoted = true;
  }
  return true;
}

/** A list separator or a word break outside quotes; false for other text.
 * An `&` or `|` that is part of a redirection (`2>&1`, `&>`, `>|`) is text. */
function scanBreak(scan: Scan, ch: string, next: string | undefined): boolean {
  const redirection =
    (ch === "&" || ch === "|") && /[<>]$/.test(scan.word?.text ?? "");
  if (redirection || (ch === "&" && next === ">" && !scan.word)) return false;
  if (ch === "\n" || ";|&()".includes(ch)) {
    end(scan);
    if (ch === "(") defineByParens(scan);
    scan.lists.push([]);
  } else if (/\s/.test(ch)) end(scan);
  else return false;
  return true;
}

/** A quote opening, or a substitution starting, outside quotes. */
function scanOpen(scan: Scan, ch: string, next: string | undefined): boolean {
  if (ch === "'" || ch === '"') {
    scan.quote = ch;
    add(scan, "");
    if (scan.word) scan.word.quoted = true;
  } else if ((ch === "$" && next === "(") || ch === "`") substitution(scan);
  else return false;
  return true;
}

/** Skip a comment to the end of its line. */
function skipComment(scan: Scan): void {
  while (scan.i + 1 < scan.shell.length && scan.shell[scan.i + 1] !== "\n")
    scan.i++;
}

/** Outside quotes: a quote or substitution opens, an escape, a comment, a
 * separator, or a character of the word. */
function scanBare(scan: Scan, ch: string, next: string | undefined): void {
  if (scanOpen(scan, ch, next) || scanEscape(scan, ch, next)) return;
  if (ch === "#" && !scan.word) skipComment(scan);
  else if (!scanBreak(scan, ch, next)) add(scan, ch, ch === "$");
}

/** The index of the `)` closing the `(` at `open`, quotes and escapes
 * honoured; -1 when the text ends first. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') i = closingQuote(text, i);
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The index of the quote closing the one at `at`; the end of the text when
 * none does. Inside double quotes a backslash escapes the next character. */
function closingQuote(text: string, at: number): number {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

/** The index of the backquote closing one opened before `from`; -1 when the
 * text ends first. */
function closingBackquote(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i;
  }
  return -1;
}

const SHELLS = new Set(["sh", "bash", "dash", "ash", "zsh"]);
const FUNCTION_NAME = /^[A-Za-z_][\w.-]*$/;
const SKIP_LIST = new Set(["for", "case", "select"]);
const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "{",
  "}",
  "!",
]);
/** Builtins that set, export or remove a variable for the commands after them. */
const DECLARERS = new Set([
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
  "unset",
]);
/** Wrappers that run the command that follows their own options. `valued`
 * options take a value (the next word, attached to a short option, or after
 * `=` on a long one); `plain` options take none. Any other option stops the
 * check, since what it does to the command's environment is not read. */
interface WrapperOptions {
  valued: string[];
  plain: string[];
}
const WRAPPERS: Record<string, WrapperOptions> = {
  env: {
    valued: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
    plain: ["-i", "--ignore-environment", "-", "-0", "--null", "-v", "--debug"],
  },
  sudo: {
    // `--preserve-env` bare is plain; `--preserve-env=LIST` names the
    // variables kept.
    valued: [
      "-u",
      "-g",
      "-C",
      "-D",
      "-h",
      "-p",
      "-r",
      "-t",
      "-T",
      "-U",
      "--user",
      "--group",
      "--host",
      "--prompt",
      "--role",
      "--type",
      "--chdir",
      "--preserve-env",
    ],
    plain: [
      "-A",
      "--askpass",
      "-b",
      "--background",
      "-E",
      "--preserve-env",
      "-H",
      "--set-home",
      "-K",
      "--remove-timestamp",
      "-k",
      "--reset-timestamp",
      "-n",
      "--non-interactive",
      "-P",
      "--preserve-groups",
      "-S",
      "--stdin",
    ],
  },
  nice: { valued: ["-n", "--adjustment"], plain: [] },
  timeout: {
    valued: ["-k", "-s", "--kill-after", "--signal"],
    plain: ["--foreground", "--preserve-status", "-v", "--verbose"],
  },
  exec: { valued: ["-a"], plain: ["-c", "-l"] },
  command: { valued: [], plain: ["-p"] },
  nohup: { valued: [], plain: [] },
  // The shell's `time` takes -p; the time command, the rest.
  time: {
    valued: ["-f", "-o", "--format", "--output"],
    plain: [
      "-p",
      "-a",
      "-q",
      "-v",
      "--portability",
      "--append",
      "--quiet",
      "--verbose",
    ],
  },
};

/** What a RUN's commands are read against. */
export interface Context {
  /** The package manager's command name. */
  command: string;
  /** The variable that pins its store. */
  storeEnv: string;
  /** The file and line, for messages. */
  where: string;
  /** Whether the stage pins the store, so a store the reader cannot place
   * is a reason to stop rather than a detail outside the rule. */
  pinned: boolean;
  /** The stage's pinned store path, when it can be read. */
  pin?: string | undefined;
  /** The store the enclosing command's environment gives this text (a `-c`
   * body or `eval` text inherits its command's setting). */
  inherited?: Invocation["store"];
  /** The functions the RUN defines, each with the store its body was read
   * with; shared by the texts nested in the RUN. */
  functions?: Map<string, string>;
}

/** One invocation of the package manager: its arguments, and the store a
 * command-level setting gives it (`cleared` when the variable is removed). */
export interface Invocation {
  args: string[];
  /** The arguments as read, with their expansions. */
  words: Word[];
  store?: Word | "cleared" | undefined;
}

/** Every invocation of the command in a shell line, into literal `-c` bodies. */
export function invocations(shell: string, context: Context): Invocation[] {
  const defined: string[] = [];
  const lists = scanShell(shell, context.where, defined);
  defineFunctions(defined, context);
  return lists.flatMap((list) => listInvocations(list, context));
}

/** The store a setting gives a command, as a comparable key: no setting is
 * the stage's pin, so setting the pinned path again is the same store. */
function storeKey(store: Invocation["store"], context: Context): string {
  if (store === "cleared") return store;
  if (store === undefined)
    return context.pin === undefined ? "" : `=${context.pin}`;
  return store.expands ? `$${store.text}` : `=${normalize(store.text)}`;
}

/** Whether a name is one the reader models as a command of its own, so a
 * function that takes it changes what the reader's model of it says. */
const modelled = (name: string, context: Context): boolean =>
  name in WRAPPERS ||
  SHELLS.has(name) ||
  DECLARERS.has(name) ||
  name === "eval" ||
  name === context.command;

/** Record the functions a shell text defines (`name() …`, `function name …`),
 * as its scanner found them, with the store their bodies are read with,
 * which is the text's own. A name defined under two stores matches neither.
 * In a pinned stage, a function named for a command the reader models stops
 * the check: its calls are not that command. */
function defineFunctions(names: string[], context: Context): void {
  context.functions ??= new Map();
  const key = storeKey(context.inherited, context);
  for (const name of names) {
    if (context.pinned && modelled(name, context))
      throw new Unreadable(
        `${context.where}: the RUN defines a function named ${name}, so its calls are not the command the check reads`,
      );
    const known = context.functions.get(name);
    context.functions.set(
      name,
      known === undefined || known === key ? key : "\0",
    );
  }
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
/** A redirection word: an optional descriptor, the operator, and the target
 * when it is written in the same word. */
const REDIRECTION = /^(?:[0-9]*|&)(?:<<<|<>|>>|>&|<&|>\||&>>?|<|>)(.*)$/s;
const textAt = (list: Word[], i: number): string => list[i]?.text ?? "";

/** The store setting an assignment word makes, if it names the store's variable. */
function storeOf(word: Word, context: Context): Word | undefined {
  const m = ASSIGNMENT.exec(word.text);
  if (m?.[1] !== context.storeEnv) return undefined;
  return { text: word.text.slice(m[0].length), expands: word.expands };
}

/** The index past the leading reserved words, assignments and redirections
 * from `at`, and the store an assignment among them sets. */
function skipPrefix(
  list: Word[],
  at: number,
  context: Context,
  store: Invocation["store"],
): { i: number; store: Invocation["store"] } {
  let i = at;
  for (;;) {
    const word = list[i];
    if (!word) break;
    const redirection = REDIRECTION.exec(word.text);
    if (RESERVED.has(word.text)) i++;
    else if (ASSIGNMENT.test(word.text)) {
      store = storeOf(word, context) ?? store;
      i++;
    } else if (redirection) i += redirection[1] ? 1 : 2;
    else break;
  }
  return { i, store };
}

/** One option of a wrapper at `at`: its name, its value, and how many words
 * it spans. Throw for an option the wrapper is not read to take. */
function wrapperOption(
  name: string,
  list: Word[],
  at: number,
  context: Context,
): { option: string; value: Word | undefined; span: number } {
  const { valued, plain } = WRAPPERS[name] ?? { valued: [], plain: [] };
  const word = list[at] ?? { text: "", expands: false };
  if (plain.includes(word.text))
    return { option: word.text, value: undefined, span: 1 };
  if (valued.includes(word.text))
    return { option: word.text, value: list[at + 1], span: 2 };
  const attached =
    /^(--[A-Za-z-]+)=(.*)$/s.exec(word.text) ??
    /^(-[A-Za-z])(.+)$/s.exec(word.text);
  if (attached && valued.includes(attached[1] ?? ""))
    return {
      option: attached[1] ?? "",
      value: { text: attached[2] ?? "", expands: word.expands },
      span: 1,
    };
  throw new Unreadable(
    `${context.where}: ${name} option ${word.text} is not read; what it does to the command's environment is unknown`,
  );
}

/** The index past one wrapper command at `at`, its flags and operands, and
 * the store it leaves the command; `at` itself when the word is no wrapper. */
function skipWrapper(
  list: Word[],
  at: number,
  context: Context,
  store: Invocation["store"],
): { i: number; store: Invocation["store"] } {
  const name = basename(textAt(list, at));
  if (!WRAPPERS[name]) return { i: at, store };
  let i = at + 1;
  // sudo resets the environment unless told to keep it.
  let kept = name !== "sudo";
  while (/^-/.test(textAt(list, i))) {
    if (textAt(list, i) === "--") {
      i++;
      break;
    }
    const { option, value, span } = wrapperOption(name, list, i, context);
    i += span;
    if (name === "env") store = envFlag(option, value, context, store);
    else if (name === "sudo") kept ||= sudoKeeps(option, value, context);
    else if (name === "exec" && option === "-c") store = "cleared";
  }
  if (name === "timeout") i++; // the duration
  return { i, store: kept ? store : "cleared" };
}

/** Whether a sudo option keeps the store's variable: `-E` and a bare
 * `--preserve-env` keep the environment, `--preserve-env=LIST` only the
 * variables it names. */
function sudoKeeps(
  option: string,
  value: Word | undefined,
  context: Context,
): boolean {
  if (option === "-E") return true;
  if (option !== "--preserve-env") return false;
  if (value === undefined) return true;
  if (value.expands)
    throw new Unreadable(
      `${context.where}: sudo --preserve-env names its variables through an expansion`,
    );
  return value.text.split(",").includes(context.storeEnv);
}

/** The store an `env` option leaves the command: cleared by `-i` or by `-u`
 * naming the store's variable. */
function envFlag(
  option: string,
  value: Word | undefined,
  context: Context,
  store: Invocation["store"],
): Invocation["store"] {
  if (option === "-S" || option === "--split-string")
    throw new Unreadable(
      `${context.where}: env ${option} runs a command written in one string, which is not read`,
    );
  if (["-i", "--ignore-environment", "-"].includes(option)) return "cleared";
  if (option !== "-u" && option !== "--unset") return store;
  if (value?.expands)
    throw new Unreadable(
      `${context.where}: env ${option} names its variable through an expansion`,
    );
  return value?.text === context.storeEnv ? "cleared" : store;
}

/** Where a shell's options end, and whether one of them is `-c`. Options may
 * be combined (`-ec`); `-o` takes a value. */
function shellOptions(rest: Word[]): { i: number; command: boolean } {
  let command = false;
  for (let i = 0; i < rest.length; i++) {
    const word = textAt(rest, i);
    if (word === "--" || word === "-") return { i: i + 1, command };
    if (/^[-+]o$/.test(word)) i++;
    else if (/^-[A-Za-z]+$/.test(word)) command ||= word.includes("c");
    else if (!/^(\+[A-Za-z]+|--[A-Za-z-]+)$/.test(word)) return { i, command };
  }
  return { i: rest.length, command };
}

/** The invocations inside a shell's `-c` body, which must be a literal; they
 * run with the store the shell's own command was given. */
function shellBody(
  rest: Word[],
  context: Context,
  store: Invocation["store"],
): Invocation[] {
  const { i, command } = shellOptions(rest);
  const operands = rest.slice(i);
  if (command) {
    const body = rest[i];
    if (!body || body.expands)
      throw new Unreadable(`${context.where}: the -c body is not a literal`);
    return invocations(body.text, { ...context, inherited: store });
  }
  if (operands.some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text)))
    throw new Unreadable(
      `${context.where}: the shell's options are not read up to its -c`,
    );
  // A script file is outside the rule, as every other script is; a script on
  // standard input is a body the reader cannot see.
  if (context.pinned && operands.every((w) => REDIRECTION.test(w.text)))
    throw new Unreadable(
      `${context.where}: a shell reads its script from standard input, which is not read`,
    );
  return [];
}

/** Where a command list's command starts, past its prefixes and wrappers,
 * and the store they set for it. */
function commandStart(
  list: Word[],
  context: Context,
): { i: number; store: Invocation["store"] } {
  let start = skipPrefix(list, 0, context, context.inherited);
  for (;;) {
    const wrapped = skipWrapper(list, start.i, context, start.store);
    if (wrapped.i === start.i) return start;
    start = skipPrefix(list, wrapped.i, context, wrapped.store);
  }
}

/** Throw when a pinned stage's RUN changes the store's variable for the
 * commands after this one: an assignment alone, or a declaring builtin. */
function refuseStoreChange(
  name: string | undefined,
  rest: Word[],
  store: Invocation["store"],
  context: Context,
): void {
  if (!context.pinned) return;
  const changes =
    name === undefined
      ? store !== context.inherited
      : DECLARERS.has(name) &&
        rest.some(
          (w) =>
            w.text === context.storeEnv || storeOf(w, context) !== undefined,
        );
  if (changes)
    throw new Unreadable(
      `${context.where}: the RUN changes ${context.storeEnv} for the commands after it, which is not read`,
    );
}

/** The invocations of the command one command list makes. */
function listInvocations(list: Word[], context: Context): Invocation[] {
  if (SKIP_LIST.has(textAt(list, 0))) return [];
  // `function name { …; }`, timed or not: the body runs where the function is
  // called, in this RUN, so its commands are read here.
  const k = pastReserved(list);
  if (isLiteral(list[k], "function"))
    return listInvocations(list.slice(k + 2), context);
  const { i, store } = commandStart(list, context);
  const head = list[i];
  const rest = list.slice(i + 1);
  const name = head && basename(head.text);
  refuseStoreChange(name, rest, store, context);
  if (!head) return [];
  if (head.expands)
    throw new Unreadable(
      `${context.where}: the command is an expansion: ${head.text}`,
    );
  return commandInvocations(basename(head.text), rest, store, context);
}

/** The invocations one named command makes with its arguments: itself, or
 * those of the text an `eval` or a shell runs. */
function commandInvocations(
  name: string,
  rest: Word[],
  store: Invocation["store"],
  context: Context,
): Invocation[] {
  if (name === "eval") {
    if (rest.some((w) => w.expands))
      throw new Unreadable(`${context.where}: eval's text is not a literal`);
    return invocations(rest.map((w) => w.text).join(" "), {
      ...context,
      inherited: store,
    });
  }
  if (SHELLS.has(name)) return shellBody(rest, context, store);
  if (name === context.command)
    return [{ args: rest.map((w) => w.text), words: rest, store }];
  refuseUnreadCall(name, store, context);
  return [];
}

/** Throw, in a pinned stage, for a call of a function the RUN defines with a
 * store other than the one its body was read with: the body runs with the
 * caller's environment. */
function refuseUnreadCall(
  name: string,
  store: Invocation["store"],
  context: Context,
): void {
  if (!context.pinned) return;
  const defined = context.functions?.get(name);
  if (defined !== undefined && defined !== storeKey(store, context))
    throw new Unreadable(
      `${context.where}: the function ${name} is called with ${context.storeEnv} set otherwise than where its body is read, which is not read`,
    );
}

/** A cache mount: the path it mounts and the cache it is (its `id`, which
 * defaults to the target). */
export interface Mount {
  target: string;
  id: string;
}

const RUN_OPTIONS = new Set(["mount", "network", "security"]);

/** The cache mount one `--mount=` value declares; undefined for another type. */
function mountOf(value: string, where: string): Mount | undefined {
  const fields = new Map(
    value.split(",").map((field) => {
      const eq = field.indexOf("=");
      return eq < 0 ? [field, ""] : [field.slice(0, eq), field.slice(eq + 1)];
    }),
  );
  if ((fields.get("type") ?? "bind") !== "cache") return undefined;
  const target =
    fields.get("target") ?? fields.get("dst") ?? fields.get("destination");
  if (!target) throw new Unreadable(`${where}: a cache mount names no target`);
  const id = fields.get("id") ?? normalize(target);
  if (target.includes("$") || id.includes("$"))
    throw new Unreadable(
      `${where}: a cache mount's target or id is an expansion (${target}, ${id}); write it literally`,
    );
  return { target: normalize(target), id };
}

/** The `type=cache` mounts among a RUN's leading options, and the rest. */
export function splitRun(
  args: string,
  where: string,
): {
  mounts: Mount[];
  body: string;
} {
  const mounts: Mount[] = [];
  let rest = args;
  for (
    let m = /^--([A-Za-z-]+)(?:=(\S*))?(?:\s+|$)/.exec(rest);
    m;
    m = /^--([A-Za-z-]+)(?:=(\S*))?(?:\s+|$)/.exec(rest)
  ) {
    if (!RUN_OPTIONS.has(m[1] ?? ""))
      throw new Unreadable(`${where}: the RUN option --${m[1]} is not read`);
    rest = rest.slice(m[0].length);
    const mount = m[1] === "mount" ? mountOf(m[2] ?? "", where) : undefined;
    if (mount) mounts.push(mount);
  }
  if (/^--/.test(rest))
    throw new Unreadable(`${where}: a RUN option is not read: ${rest}`);
  if (/<<-?\s*['"\\]?[A-Za-z_]/.test(rest))
    throw new Unreadable(`${where}: a heredoc body is not read`);
  return { mounts, body: rest };
}

const normalize = (path: string) => path.replace(/\/+$/, "") || "/";

/** The pairs an ENV instruction sets; `KEY VALUE` or `KEY=VALUE…`. The
 * one-pair form's value is the rest of the line; one of several words is
 * undefined, since how Docker joins them is not read. */
export function envPairs(
  args: string,
  where: string,
): [string, Word | undefined][] {
  const words = segments(args, where).flat();
  if (!words.length) throw new Unreadable(`${where}: ENV sets nothing`);
  if (!words[0]?.text.includes("=")) {
    const key = words[0]?.text ?? "";
    const value = args.slice(args.indexOf(key) + key.length).trim();
    const values = segments(value, where).flat();
    if (values.length > 1) return [[key, undefined]];
    return [[key, values[0] ?? { text: "", expands: false }]];
  }
  return words.map((w) => {
    const eq = w.text.indexOf("=");
    if (eq < 0)
      throw new Unreadable(`${where}: ENV pair without '=': ${w.text}`);
    return [
      w.text.slice(0, eq),
      { text: w.text.slice(eq + 1), expands: w.expands },
    ];
  });
}

/** A pin a build argument set: the path, or why the path cannot be read. */
type ArgPin = { path: string } | { unreadable: string };

interface Stage {
  name: string;
  /** The pin an ENV set, inherited by the stages built FROM this one. */
  envPin: string | undefined;
  /** The pin an ARG set, inherited by the stages built FROM this one. */
  argPin: ArgPin | undefined;
  /** A SHELL that is not a POSIX shell, inherited likewise. */
  foreignShell: string | undefined;
  /** The cache id each store path is mounted as, shared with the stages
   * built FROM this one and with the stage it builds on. */
  ids: Map<string, { id: string; line: number }>;
}

/** The path the stage's RUNs read the store from; ENV outranks ARG. Throw
 * when the path is a build argument whose value the build was not given. */
function pinOf(stage: Stage): string | undefined {
  if (stage.envPin !== undefined) return stage.envPin;
  if (stage.argPin && "unreadable" in stage.argPin)
    throw new Unreadable(stage.argPin.unreadable);
  return stage.argPin?.path;
}

/** The stage's pin when it can be read, else undefined; for the checks that
 * apply only where a path is known. */
function peekPin(stage: Stage): string | undefined {
  return (
    stage.envPin ??
    (stage.argPin && "path" in stage.argPin ? stage.argPin.path : undefined)
  );
}

/** The stage a FROM opens, inheriting the pins and SHELL of a stage it
 * builds on. */
function openStage(
  args: string,
  stages: Stage[],
  index: number,
  where: string,
): Stage {
  const words = args.split(/\s+/).filter((w) => w && !w.startsWith("--"));
  const image = (words[0] ?? "").toLowerCase();
  const as = words.findIndex((w) => w.toUpperCase() === "AS");
  const name = as >= 0 ? (words[as + 1] ?? "").toLowerCase() : `stage ${index}`;
  if (
    image.includes("$") &&
    stages.some((s) => s.envPin !== undefined || s.argPin !== undefined)
  )
    throw new Unreadable(
      `${where}: FROM names its base through an expansion (${words[0]}) while a stage pins the store, so what this stage inherits cannot be read; name the base literally`,
    );
  const base = stages.find((s) => s.name === image);
  return {
    name,
    envPin: base?.envPin,
    argPin: base?.argPin,
    foreignShell: base?.foreignShell,
    ids: base?.ids ?? new Map(),
  };
}

/** Apply an ENV instruction's store pin to the stage; the pins it set. */
function pinStage(
  stage: Stage,
  args: string,
  where: string,
  options: Options,
): number {
  let pinned = 0;
  for (const [key, value] of envPairs(args, where)) {
    if (key !== options.storeEnv) continue;
    if (value === undefined)
      throw new Unreadable(
        `${where}: ENV ${key} is set to several words in the one-pair form, which is not read; write ENV ${key}=<path>`,
      );
    if (value.expands)
      throw new Unreadable(`${where}: ${key} is set to an expansion`);
    stage.envPin = normalize(value.text);
    pinned++;
  }
  return pinned;
}

/** The names and defaults an ARG instruction declares; `NAME` or `NAME=default`. */
export function argPairs(
  args: string,
  where: string,
): [string, Word | undefined][] {
  const words = segments(args, where).flat();
  if (!words.length) throw new Unreadable(`${where}: ARG declares nothing`);
  return words.map((w) => {
    const eq = w.text.indexOf("=");
    if (eq < 0) return [w.text, undefined];
    return [
      w.text.slice(0, eq),
      { text: w.text.slice(eq + 1), expands: w.expands },
    ];
  });
}

/**
 * Apply an ARG instruction's store pin to the stage; the pins it set. A
 * build argument's value is the one the build passes; a default does not
 * establish it, since `--build-arg` overrides it. So the path is the value
 * given with this gate's own `--build-arg`, and without one the pin is
 * unreadable, which stops the check once a RUN of the stage invokes the
 * command.
 */
function pinStageByArg(
  stage: Stage,
  args: string,
  where: string,
  options: Options,
): number {
  let pinned = 0;
  for (const [key] of argPairs(args, where)) {
    if (key !== options.storeEnv) continue;
    const given = options.buildArgs.get(key);
    stage.argPin =
      given === undefined
        ? {
            unreadable: `${where}: ARG ${key} takes its value from the build command, which this check was not given; pass the build's value with --build-arg ${key}=<path>, or pin the store with ENV`,
          }
        : given.includes("$")
          ? { unreadable: `${where}: --build-arg ${key} is an expansion` }
          : { path: normalize(given) };
    pinned++;
  }
  return pinned;
}

/** The SHELL an instruction sets: undefined for a POSIX shell, else its text. */
function shellOf(args: string, where: string): string | undefined {
  let argv: unknown;
  try {
    argv = JSON.parse(args);
  } catch {
    throw new Unreadable(`${where}: SHELL is not a JSON array`);
  }
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string"))
    throw new Unreadable(`${where}: SHELL is not an array of strings`);
  const [head, ...rest] = argv as string[];
  const posix =
    head !== undefined &&
    SHELLS.has(basename(head)) &&
    onlyOptions(rest) &&
    /^-[A-Za-z]*c[A-Za-z]*$/.test(rest[rest.length - 1] ?? "");
  return posix ? undefined : args;
}

/** Whether a SHELL's arguments are all options (`-e`, `+x`, `-o pipefail`):
 * an operand among them is a script or argument the RUN text does not show. */
function onlyOptions(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? "";
    if (/^[-+]o$/.test(word)) {
      if (!/^[a-z]+$/.test(rest[++i] ?? "")) return false;
    } else if (!/^[-+][A-Za-z]+$/.test(word)) return false;
  }
  return true;
}

/** The cache mounts of the stores' paths, checked to be one cache each: the
 * first mount of a path in the stage lineage records its id, a later one
 * with another id is a finding. */
function idFindings(
  mounts: Mount[],
  stores: Set<string>,
  ids: Map<string, { id: string; line: number }>,
  file: string,
  line: number,
): Finding[] {
  const findings: Finding[] = [];
  for (const mount of mounts.filter((m) => stores.has(m.target))) {
    const first = ids.get(mount.target);
    if (!first) ids.set(mount.target, { id: mount.id, line });
    else if (first.id !== mount.id)
      findings.push({
        rule: "cache-id-mismatch",
        file,
        line,
        problem: `this RUN mounts ${mount.target} as cache '${mount.id}', but line ${first.line} mounts it as cache '${first.id}'; they are different caches, so this RUN reads a store the other did not fill`,
        remedy: `give every cache mount of ${mount.target} the same id (or none, so each defaults to the target)`,
      });
  }
  return findings;
}

/** Whether an argument's expansion can make it the store flag: it splits, or
 * the literal text before it is a start of the flag, or the flag itself
 * without its `=`. */
function couldBeFlag(word: Word, flag: string): boolean {
  if (!word.expands) return false;
  if (word.splits) return true;
  const lead = word.lead ?? "";
  if (lead.startsWith(`${flag}=`)) return false;
  return flag.startsWith(lead) || lead.startsWith(flag);
}

/** The findings of one invocation: a flag pin, and a store it reads unmounted. */
function callFindings(
  call: Invocation,
  pin: string | undefined,
  run: { stage: Stage; mounts: Mount[] },
  file: string,
  line: number,
  options: Options,
): Finding[] {
  const findings: Finding[] = [];
  const flag = call.args.find(
    (a) => a === options.storeFlag || a.startsWith(`${options.storeFlag}=`),
  );
  const hidden = flag
    ? undefined
    : call.words.find((w) => couldBeFlag(w, options.storeFlag));
  if (hidden)
    throw new Unreadable(
      `${file}:${line}: an argument of ${options.command} is an expansion (${hidden.text}) that can pass ${options.storeFlag}, which is not read`,
    );
  if (flag)
    findings.push({
      rule: "store-flag",
      file,
      line,
      problem: `${options.command} pins its store with ${flag}, which binds this one process; a child process it spawns falls back to the default store`,
      remedy: `drop the flag and set ENV ${options.storeEnv}=<path> on the stage, which every later process inherits`,
    });
  if (pin !== undefined && !run.mounts.some((m) => m.target === pin))
    findings.push({
      rule: "cache-mount-missing",
      file,
      line,
      problem: `stage '${run.stage.name}' keeps the ${options.command} store on ${pin}, and this RUN invokes ${options.command} without mounting it, so it reads an empty store`,
      remedy: `add --mount=type=cache,target=${pin} to this RUN (a cache mount lives only for the RUN that declares it)`,
    });
  return findings;
}

/** The invocations of the command one RUN body makes, in either form. */
function runInvocations(
  stage: Stage,
  body: string,
  where: string,
  options: Options,
): Invocation[] {
  const argv = execArgv(body);
  if (!argv && stage.foreignShell !== undefined)
    throw new Unreadable(
      `${where}: the stage's SHELL is ${stage.foreignShell}, whose RUN text is not read`,
    );
  const context: Context = {
    command: options.command,
    storeEnv: options.storeEnv,
    where,
    pinned: stage.envPin !== undefined || stage.argPin !== undefined,
    pin: peekPin(stage),
  };
  return argv ? listInvocations(argv, context) : invocations(body, context);
}

/** The findings of one RUN's invocations of the package manager. */
function checkRun(
  stage: Stage,
  args: string,
  file: string,
  line: number,
  options: Options,
): { findings: Finding[]; checked: number } {
  const where = `${file}:${line}`;
  const { mounts, body } = splitRun(args, where);
  const calls = runInvocations(stage, body, where, options);
  // A build argument the check was not given stops it only once a RUN
  // invokes the command.
  const pin = calls.length ? pinOf(stage) : peekPin(stage);
  const pins = calls.map((call) => callPin(call, pin, where, options));
  const stores = new Set(
    [pin, ...pins].filter((p): p is string => p !== undefined),
  );
  const findings = idFindings(mounts, stores, stage.ids, file, line);
  calls.forEach((call, k) => {
    findings.push(
      ...callFindings(call, pins[k], { stage, mounts }, file, line, options),
    );
  });
  return { findings, checked: calls.length };
}

/** The store one invocation reads: its own setting, else the stage's pin. */
function callPin(
  call: Invocation,
  stagePin: string | undefined,
  where: string,
  options: Options,
): string | undefined {
  // A stage that pins nothing is outside the rule, whatever one command sets.
  if (call.store === undefined || stagePin === undefined) return stagePin;
  if (call.store === "cleared")
    throw new Unreadable(
      `${where}: ${options.command} runs with ${options.storeEnv} removed from its environment, so the store it reads is not the stage's`,
    );
  if (call.store.expands)
    throw new Unreadable(
      `${where}: ${options.storeEnv} is set to an expansion for ${options.command}`,
    );
  return normalize(call.store.text);
}

/** Check one Dockerfile's text; findings name `file`. */
export function checkDockerfile(
  text: string,
  file: string,
  options: Options,
): { findings: Finding[]; stages: number; pinned: number; checked: number } {
  const findings: Finding[] = [];
  const stages: Stage[] = [];
  let stage: Stage | undefined;
  let pinned = 0,
    checked = 0;
  for (const { keyword, args, line } of instructions(text, file)) {
    const where = `${file}:${line}`;
    if (keyword === "FROM") {
      stage = openStage(args, stages, stages.length, where);
      stages.push(stage);
    } else if (keyword === "ENV" && stage)
      pinned += pinStage(stage, args, where, options);
    else if (keyword === "ARG" && stage)
      pinned += pinStageByArg(stage, args, where, options);
    else if (keyword === "SHELL" && stage)
      stage.foreignShell = shellOf(args, where);
    else if (keyword === "RUN" && stage) {
      const run = checkRun(stage, args, file, line, options);
      findings.push(...run.findings);
      checked += run.checked;
    }
  }
  if (!stages.length) throw new Unreadable(`${file}: no FROM instruction`);
  return { findings, stages: stages.length, pinned, checked };
}

/** The words of an exec-form RUN (a JSON array of strings, run without a
 * shell); undefined when the body is not one, which Docker runs as shell
 * form. Its words are read with the same wrapper and interpreter handling. */
function execArgv(body: string): Word[] | undefined {
  if (!body.trim().startsWith("[")) return undefined;
  const argv = parsedJson(body);
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string"))
    return undefined;
  return (argv as string[]).map((text) => ({ text, expands: false }));
}

/** The JSON a text holds, or the parse error when it holds none. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    return error;
  }
}

function parseArgs(args: string[]): { options: Options; files: string[] } {
  const options = { ...DEFAULTS, buildArgs: new Map<string, string>() };
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const value = () => optionValue(args, i++, usage);
    if (arg === "--command") options.command = value();
    else if (arg === "--store-env") options.storeEnv = value();
    else if (arg === "--store-flag") options.storeFlag = value();
    else if (arg === "--build-arg") {
      const pair = value();
      const m = ASSIGNMENT.exec(pair);
      if (!m)
        throw new Error(`--build-arg takes NAME=VALUE: ${pair}\n${usage}`);
      options.buildArgs.set(m[1] ?? "", pair.slice(m[0].length));
    } else if (arg.startsWith("--"))
      throw new Error(`unknown option ${arg}\n${usage}`);
    else files.push(arg);
  }
  if (!files.length) throw new Error(`no Dockerfile given\n${usage}`);
  return { options, files };
}

export function main(args = process.argv.slice(2)): number {
  const { options, files } = parseArgs(args);
  const findings: Finding[] = [];
  let stages = 0,
    pinned = 0,
    checked = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return couldNotCheck(GATE, `cannot read ${file}`);
    }
    if (!text.trim()) return couldNotCheck(GATE, `${file} is empty`);
    try {
      const result = checkDockerfile(text, file, options);
      findings.push(...result.findings);
      stages += result.stages;
      pinned += result.pinned;
      checked += result.checked;
    } catch (error) {
      if (error instanceof Unreadable)
        return couldNotCheck(GATE, error.message);
      throw error;
    }
  }
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  const note =
    pinned === 0
      ? `; no stage pins the ${options.command} store with ${options.storeEnv}, so the mount rule had nothing to check`
      : "";
  console.log(
    `OK — ${files.length} Dockerfile(s), ${stages} stage(s), ${checked} ${options.command} invocation(s) checked${note}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
