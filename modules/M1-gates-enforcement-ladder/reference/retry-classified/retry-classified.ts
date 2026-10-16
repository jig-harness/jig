#!/usr/bin/env bun
// Classified retry: a step retries only an error it has classified as
// transient; anything else aborts at once with the original message.
//
// The problem it solves. A retry loop that retries every failure turns a
// permanent error (a missing permission, a wrong name, an expired
// credential) into minutes of waiting, and then reports the timeout instead
// of the error, so the person who reads the log fixes the wrong thing. A
// retry loop that matches guessed wording never fires, because the tool's
// real message differs from the guess. So: the transient patterns live in a
// file, each with the reason it is transient, and the classifier is tested
// against messages recorded from the real tool (`--classify`).
//
// Behaviour. The command runs; on a non-zero exit its output is classified
// against the patterns. Transient, with attempts left: a note on standard
// error and another attempt after the delay, which doubles after each
// attempt up to a ceiling. Anything else: the output is printed as the
// command wrote it, then a line saying why there was no retry, and the
// command's own exit code is returned. The last attempt's failure is
// reported the same way, with the count. A child's could not check (exit 2)
// is never retried, whatever its output says. A line matching a pattern of
// the optional permanent list makes the failure permanent even when another
// line looks transient: a command that reports its own error beside an
// earlier rate-limit warning failed for the error.
//
// The command's standard input is closed: a retried command cannot read the
// same input twice, so a command that reads standard input is not one to
// wrap. Its output is spooled to temporary files, not held in memory. A
// cancellation of the wrapper (SIGINT, SIGTERM, SIGHUP) is never retried:
// during an attempt it is passed to the command and its descendants, which
// are killed if they outlive a grace period; during the delay before the
// next attempt it ends the wait at once. Either way the last attempt's output
// is printed and the wrapper exits 2. A line longer than the classifier reads
// (4 MiB) is not cut to fit: the attempt is reported as not classified.
//
// Exit codes: 0 when an attempt passed; the command's own code when it
// failed for good (so a child's could not check stays 2); 2 when the wrapper
// itself could not decide: a usage error, a pattern file that is missing,
// unreadable, empty, or holds a pattern without a reason or one that does
// not compile, a command that could not be started, a child killed by a
// signal, the wrapper cancelled, an output line too long to classify, or
// `--classify` given nothing to classify.
//
// Usage:
//   retry-classified.ts --transient <patterns> [--permanent <patterns>]
//     [--attempts 3] [--delay-ms 2000] [--max-delay-ms 60000] [--] <command> [args...]
//   retry-classified.ts --transient <patterns> [--permanent <patterns>] --classify < message.txt
// A pattern file is a line-based list: `#` lines give the reason for the
// patterns that follow, a blank line ends a group, each other line is one
// extended regular expression tested against every line of the output.
import { readFileSync } from "node:fs";
import { cli, ere } from "../../../../lib/cli.ts";
import { reasonedEntries } from "../../../../lib/findings.ts";
import {
  linesOf,
  removeSpool,
  replayTo,
  type Spool,
  spooledRun,
} from "../../../../lib/spooled-run.ts";

const usage = [
  "usage: retry-classified.ts --transient <patterns> [--permanent <patterns>] [--attempts <n>] [--delay-ms <n>] [--max-delay-ms <n>] [--] <command> [args...]",
  "       retry-classified.ts --transient <patterns> [--permanent <patterns>] --classify < message",
].join("\n");

export interface Pattern {
  source: string;
  regexp: RegExp;
  reason: string;
}

/** The patterns of a list; throw unless every one has a reason. */
export function parsePatterns(
  content: string,
  where: string,
  kind = "transient",
): Pattern[] {
  const patterns = reasonedEntries(content).map(({ text, line, reason }) => {
    if (!reason)
      throw new Error(`${where}:${line}: pattern without a reason: ${text}`);
    try {
      return { source: text, regexp: ere(text), reason };
    } catch {
      throw new Error(`${where}:${line}: pattern does not compile: ${text}`);
    }
  });
  if (patterns.length === 0)
    throw new Error(
      `${where}: no ${kind} pattern; the list would classify nothing`,
    );
  return patterns;
}

/** How a failure's lines classify: the transient pattern that authorizes a
 * retry, or the permanent pattern that forbids one, or neither. */
export interface Verdict {
  transient?: Pattern | undefined;
  permanent?: Pattern | undefined;
}

/** Classify a failure's lines: a permanent match anywhere wins; otherwise
 * the first transient match. */
export function classifyLines(
  lines: Iterable<string>,
  transient: Pattern[],
  permanent: Pattern[] = [],
): Verdict {
  let first: Pattern | undefined;
  for (const line of lines) {
    const fatal = permanent.find((p) => p.regexp.test(line));
    if (fatal) return { permanent: fatal };
    first ??= transient.find((p) => p.regexp.test(line));
  }
  return { transient: first };
}

/** The transient pattern that authorizes a retry of the message, or undefined. */
export function classify(
  message: string,
  patterns: Pattern[],
  permanent: Pattern[] = [],
): Pattern | undefined {
  return classifyLines(message.split("\n"), patterns, permanent).transient;
}

export interface Options {
  patternsPath: string;
  permanentPath: string;
  attempts: number;
  delayMs: number;
  maxDelayMs: number;
  classifyOnly: boolean;
  command: string[];
}

function integer(value: string, name: string, min: number): number {
  if (!/^[0-9]{1,9}$/.test(value) || Number(value) < min)
    throw new Error(
      `${name} must be an integer of at least ${min}: ${value}\n${usage}`,
    );
  return Number(value);
}

/** Apply one option to the options being parsed; the value is the next word. */
const setters: Record<string, (options: Options, value: string) => void> = {
  "--transient": (options, value) => {
    options.patternsPath = value;
  },
  "--permanent": (options, value) => {
    options.permanentPath = value;
  },
  "--attempts": (options, value) => {
    options.attempts = integer(value, "--attempts", 1);
  },
  "--delay-ms": (options, value) => {
    options.delayMs = integer(value, "--delay-ms", 0);
  },
  "--max-delay-ms": (options, value) => {
    options.maxDelayMs = integer(value, "--max-delay-ms", 0);
  },
};

/** Throw unless the parsed options name a pattern file and one mode. */
function validate(options: Options): Options {
  if (!options.patternsPath)
    throw new Error(`--transient is required\n${usage}`);
  if (options.maxDelayMs < options.delayMs)
    throw new Error(`--max-delay-ms is below --delay-ms\n${usage}`);
  if (options.classifyOnly && options.command.length)
    throw new Error(`--classify takes no command\n${usage}`);
  if (!options.classifyOnly && options.command.length === 0)
    throw new Error(`no command given\n${usage}`);
  return options;
}

export function parseArgs(args: string[]): Options {
  const options: Options = {
    patternsPath: "",
    permanentPath: "",
    attempts: 3,
    delayMs: 2000,
    maxDelayMs: 60_000,
    classifyOnly: false,
    command: [],
  };
  // Options come first; the command starts at `--` or at the first word
  // that is not an option. The separator is optional because a runtime may
  // consume a leading `--` before the script sees it.
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      i++;
      break;
    }
    const set = setters[arg];
    if (set) {
      const value = args[++i];
      if (value === undefined || value === "")
        throw new Error(`${arg} needs a value\n${usage}`);
      set(options, value);
    } else if (arg === "--classify") options.classifyOnly = true;
    else if (arg.startsWith("--"))
      throw new Error(`unknown option ${arg}\n${usage}`);
    else break;
  }
  options.command = args.slice(i);
  return validate(options);
}

function readPatterns(path: string, kind = "transient"): Pattern[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read the pattern file: ${path}`);
  }
  return parsePatterns(content, path, kind);
}

function classifyStdin(transient: Pattern[], permanent: Pattern[]): number {
  const message = readFileSync(0, "utf8");
  if (message.trim() === "")
    throw new Error("nothing to classify on standard input");
  const verdict = classifyLines(message.split("\n"), transient, permanent);
  if (verdict.transient) {
    console.log(
      `transient: ${verdict.transient.source} (${verdict.transient.reason})`,
    );
    return 0;
  }
  console.log(
    verdict.permanent
      ? `fatal: permanent pattern matches: ${verdict.permanent.source} (${verdict.permanent.reason})`
      : "fatal: no transient pattern matches",
  );
  return 1;
}

/** Why the final attempt's failure is not retried, for the log. */
function verdict(n: number, code: number, found: Verdict): string {
  if (code === 2)
    return `retry-classified: attempt ${n} could not check (exit 2); not retried`;
  if (found.permanent)
    return `retry-classified: attempt ${n} failed with a permanent error (${found.permanent.source}); not retried, exit ${code}`;
  return found.transient
    ? `retry-classified: still failing after ${n} attempt(s); last error was transient (${found.transient.source}), exit ${code}`
    : `retry-classified: attempt ${n} failed with an error not classified as transient; not retried, exit ${code}`;
}

/** Print an attempt's output as the command wrote it. */
function replay(run: Spool): void {
  replayTo(run.out, 1);
  replayTo(run.err, 2);
}

/** One attempt's exit code; throw when the child did not finish on its own. */
function finished(run: Spool, n: number): number {
  if (run.interrupted) {
    replay(run);
    throw new Error(
      `the wrapper was cancelled by ${run.interrupted} during attempt ${n}; not retried`,
    );
  }
  if (run.code !== null) return run.code;
  replay(run);
  throw new Error(
    `attempt ${n} was killed by ${run.signal ?? "a signal"} before it finished; not retried`,
  );
}

/** The output lines of an attempt, standard error first. */
function* outputOf(run: Spool): Generator<string> {
  yield* linesOf(run.err);
  yield* linesOf(run.out);
}

/** Classify an attempt's output; a line too long to read is not a verdict,
 * so the attempt is printed and the wrapper stops. */
function classifyRun(
  run: Spool,
  n: number,
  transient: Pattern[],
  permanent: Pattern[],
): Verdict {
  try {
    return classifyLines(outputOf(run), transient, permanent);
  } catch (error) {
    replay(run);
    throw new Error(
      `attempt ${n} failed and its output could not be classified (${error instanceof Error ? error.message : String(error)}); not retried`,
      { cause: error },
    );
  }
}

/** The cancellation of the whole retry: the first signal, and a wait that
 * ends early when one arrives. */
function cancellation() {
  const state: { signal: string | null; wake: () => void } = {
    signal: null,
    wake: () => undefined,
  };
  const on = (signal: NodeJS.Signals) => {
    state.signal ??= signal;
    state.wake();
  };
  for (const signal of CANCELS) process.on(signal, on);
  return {
    get signal() {
      return state.signal;
    },
    /** Wait `ms`, or less when a cancellation arrives. */
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        if (state.signal) return resolve();
        const timer = setTimeout(resolve, ms);
        state.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }),
    stop: () => {
      for (const signal of CANCELS) process.off(signal, on);
    },
  };
}

const CANCELS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  const transient = readPatterns(options.patternsPath);
  const permanent = options.permanentPath
    ? readPatterns(options.permanentPath, "permanent")
    : [];
  if (options.classifyOnly) return classifyStdin(transient, permanent);
  const cancel = cancellation();
  try {
    return await attempts(options, transient, permanent, cancel);
  } finally {
    cancel.stop();
  }
}

async function attempts(
  options: Options,
  transient: Pattern[],
  permanent: Pattern[],
  cancel: ReturnType<typeof cancellation>,
): Promise<number> {
  let delay = options.delayMs;
  for (let n = 1; ; n++) {
    const run = await spooledRun(options.command, { stdin: "ignore" });
    try {
      const code = finished(run, n);
      // Exit 0 passed, and exit 2 is the child's own could not check: neither
      // is a failure to classify.
      const found =
        code === 0 || code === 2
          ? {}
          : classifyRun(run, n, transient, permanent);
      if (found.transient && n < options.attempts) {
        console.error(
          `retry-classified: attempt ${n} of ${options.attempts} failed with a transient error (${found.transient.source}); retrying in ${delay} ms`,
        );
        if (delay) await cancel.wait(delay);
        if (cancel.signal) {
          replay(run);
          throw new Error(
            `the wrapper was cancelled by ${cancel.signal} before attempt ${n + 1}; not retried`,
          );
        }
        delay = Math.min(delay * 2, options.maxDelayMs);
        continue;
      }
      replay(run);
      if (code !== 0) console.error(verdict(n, code, found));
      return code;
    } finally {
      removeSpool(run);
    }
  }
}

if (import.meta.main) cli(() => main());
