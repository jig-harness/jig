#!/usr/bin/env bun
// Quiet run: a gate command speaks to an agent in a condensed voice on green
// and in full on red, and keeps its own exit status.
//
// The problem it solves. An agent that runs a test suite or a lint pays for
// every line the run prints, and a clean run prints hundreds of lines that
// say nothing it needs. Piping the run through a filter (`| tail`, `| grep`)
// is the obvious fix and the wrong one: the pipe's status is the filter's,
// so a failing suite comes out as a pass. This wrapper captures the command's
// output, prints a one-line verdict and the last few lines when it passed,
// prints everything when it failed, and exits with the command's own status.
//
// The verdict line. Every run ends with one line a reader can grep for:
//   <name>: passed — <n> line(s) condensed, last <k> shown
//   <name>: FAILED (exit <code>)
//   <name>: could not run — <reason>
// A run with several parts calls this wrapper once per part, each with its
// `--name`, so the reader counts one verdict line per part. A part without a
// verdict line did not run; it never counts as passed.
//
// Exit codes: the command's own code when it ran (0 passed; any other code
// passes through unchanged, so a child's "could not check" stays 2); 2 when
// the wrapper could not run or finish the command (usage error, an
// executable that was not found, a child killed by a signal, the wrapper
// itself cancelled). Output the child wrote before a signal is printed, not
// dropped.
//
// The output is spooled to temporary files, not held in memory, so a
// verbose run cannot exhaust the wrapper, and only the requested tail is
// read back, whole lines however long the run. A cancellation of the wrapper
// (SIGINT, SIGTERM, SIGHUP) is passed to the command and every process it
// started, which are killed if they outlive a grace period, and what the
// command wrote is still printed. Standard input is the wrapper's own, passed through.
//
// Usage:
//   quiet-run.ts [--name <part>] [--tail <n>] [--] <command> [args...]
// Never wrap a command that does not exit on its own (a watch mode, a dev
// server): the verdict comes only when the command ends.
import { writeSync } from "node:fs";
import { basename } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import {
  lastLinesOf,
  lineCount,
  removeSpool,
  replayTo,
  type Spool,
  spooledRun,
} from "../../../../lib/spooled-run.ts";

const usage =
  "usage: quiet-run.ts [--name <part>] [--tail <n>] [--] <command> [args...]";

export interface Options {
  name: string;
  tail: number;
  command: string[];
}

export function parseArgs(args: string[]): Options {
  let name: string | undefined,
    tail = 25,
    i = 0;
  // Options come first; the command starts at `--` or at the first word
  // that is not an option. The separator is optional because a runtime may
  // consume a leading `--` before the script sees it.
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--name") name = args[++i];
    else if (arg === "--tail") tail = parseTail(args[++i] ?? "");
    else if (arg.startsWith("--"))
      throw new Error(`unknown option ${arg}\n${usage}`);
    else break;
  }
  const command = args.slice(i);
  if (name === undefined || name === "") name = basename(command[0] ?? "");
  if (command.length === 0 || name === "")
    throw new Error(`no command given\n${usage}`);
  return { name, tail, command };
}

function parseTail(value: string): number {
  if (!/^[0-9]{1,6}$/.test(value))
    throw new Error(
      `--tail must be a non-negative integer: ${value}\n${usage}`,
    );
  return Number(value);
}

/** The last `count` lines of `text`, as text; empty when count is zero. */
export function lastLines(text: string, count: number): string {
  if (count === 0 || text === "") return "";
  const lines = text.replace(/\n$/, "").split("\n");
  return `${lines.slice(-count).join("\n")}\n`;
}

/** Print a line on standard output, in order with the replayed streams. */
const say = (line: string) => writeSync(1, `${line}\n`);

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { name, tail, command } = parseArgs(args);
  let spool: Spool;
  try {
    spool = await spooledRun(command, { stdin: "inherit" });
  } catch (error) {
    say(
      `${name}: could not run — ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  try {
    return verdict(name, tail, spool);
  } finally {
    removeSpool(spool);
  }
}

/** Print the run's output and its verdict line; the exit status. */
function verdict(name: string, tail: number, spool: Spool): number {
  if (spool.code === null || spool.interrupted) {
    // Red, and red when cut short: everything the command wrote, each stream
    // ending its last line, then the verdict, so the verdict is the last
    // line on every outcome.
    replayTo(spool.out, 1);
    replayTo(spool.err, 2);
    say(
      spool.interrupted
        ? `${name}: could not run — the wrapper was cancelled by ${spool.interrupted} before the command finished`
        : `${name}: could not run — killed by ${spool.signal ?? "a signal"} before it finished`,
    );
    return 2;
  }
  if (spool.code !== 0) {
    replayTo(spool.out, 1);
    replayTo(spool.err, 2);
    say(`${name}: FAILED (exit ${spool.code})`);
    return spool.code;
  }
  const shown = lastLines(
    lastLinesOf(spool.out, tail) + lastLinesOf(spool.err, tail),
    tail,
  );
  writeSync(1, shown);
  say(
    `${name}: passed — ${lineCount(spool.out) + lineCount(spool.err)} line(s) condensed, last ${shown === "" ? 0 : shown.replace(/\n$/, "").split("\n").length} shown`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
