#!/usr/bin/env bun
/** Shell-free operations whose ordering or filesystem checks belong to the drive. */
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { fail, isGitSha, readStdinAll, runMain } from "./lib/cli.ts";
import {
  gitCallTimeoutSeconds,
  helperTimeoutSeconds,
  run,
} from "./lib/proc.ts";

type Result = { code: number; stdout: string; stderr: string };
type Runner = (argv: string[], stdin?: string) => Promise<Result>;
const script = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const execute: Runner = (argv, stdin) =>
  run(argv, {
    timeoutSec:
      argv[0] === "git" ? gitCallTimeoutSeconds() : helperTimeoutSeconds(),
    ...(stdin !== undefined ? { stdin } : {}),
  });

/** A failed producer cannot certify an empty finding set, even after partial output. */
export async function collectFindings(
  kind: "threads" | "summary",
  args: string[],
  executeCommand: Runner = execute,
): Promise<Result> {
  const pr = args.filter((arg) => arg !== "--bots-only");
  if (pr.length > 1 || pr.some((arg) => arg.startsWith("--")))
    fail(2, "enumeration takes [PR] [--bots-only]");
  const producer =
    kind === "threads"
      ? [
          process.execPath,
          script(
            "../../resolve-review-comments/scripts/list-unresolved-threads.ts",
          ),
          ...args,
        ]
      : [
          process.execPath,
          script("summary-findings.ts"),
          ...pr,
          "--configured-reviewer-only",
        ];
  const records = await executeCommand(producer);
  if (records.code !== 0) return { ...records, stdout: "" };
  const filtered = await executeCommand(
    [
      process.execPath,
      script("self-inflicted.ts"),
      ...pr,
      ...(kind === "summary" ? ["--summary-report"] : []),
    ],
    records.stdout,
  );
  return {
    ...filtered,
    stdout: filtered.code === 0 ? filtered.stdout : "",
    stderr: records.stderr + filtered.stderr,
  };
}

/** Exclusive hard-link publication refuses a destination created since the warning. */
export function recoverState(source: string, destination: string): void {
  const before = lstatSync(source);
  if (!before.isFile()) fail(1, "orphan state must be a regular file");
  linkSync(source, destination);
  const linked = lstatSync(destination);
  const current = lstatSync(source);
  if (
    linked.dev !== before.dev ||
    linked.ino !== before.ino ||
    current.dev !== linked.dev ||
    current.ino !== linked.ino
  ) {
    fail(
      1,
      "source changed during recovery; both paths retained for inspection",
    );
  }
  unlinkSync(source);
}

/** Probe an existing regular log for append access without creating or writing it. */
export function checkLog(path: string): void {
  const before = statSync(path);
  if (!before.isFile()) fail(1, "driver log is not a regular file");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      fail(1, "driver log is not a regular file");
  } finally {
    closeSync(fd);
  }
}

/** Resolve HEAD before dispatch while keeping the underlying script's guards and exits. */
export async function runAtHead(
  operation: string,
  args: string[],
  stdin?: string,
  executeCommand: Runner = execute,
): Promise<Result> {
  if (args.some((arg) => ["--sha", "--head", "--pushed-sha"].includes(arg)))
    fail(2, `${operation}: HEAD is computed internally; do not supply a SHA`);
  const head = await executeCommand(["git", "rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || !isGitSha(head.stdout.trim()))
    fail(1, "could not read a full local HEAD");
  const stateOperation =
    operation === "stamp-held" || operation === "claim-held";
  const result = await executeCommand(
    [
      process.execPath,
      script(stateOperation ? "drive-state.ts" : `${operation}.ts`),
      ...(stateOperation ? [operation] : []),
      ...args,
      operation === "stamp-held" ? "--sha" : "--pushed-sha",
      head.stdout.trim(),
    ],
    stdin,
  );
  return result;
}

function emit(result: Result): number {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  return result.code;
}

async function enumerateCommand(
  kind: "threads" | "summary",
  args: string[],
): Promise<number> {
  return emit(await collectFindings(kind, args));
}

function checkLogCommand(args: string[]): number {
  if (args.length !== 1) fail(2, "check-log: expected one path");
  checkLog(args[0] as string);
  return 0;
}

function recoverStateCommand(args: string[]): number {
  if (args.length !== 2)
    fail(2, "recover-state: expected source and destination paths");
  recoverState(args[0] as string, args[1] as string);
  return 0;
}

async function heldCommand(operation: string, args: string[]): Promise<number> {
  const stdin =
    operation === "answer-summary-finding" ? await readStdinAll() : undefined;
  return emit(await runAtHead(operation, args, stdin));
}

type Handler = (args: string[]) => number | Promise<number>;
const handlers: Record<string, Handler> = {
  "enumerate-threads": (args) => enumerateCommand("threads", args),
  "enumerate-summary": (args) => enumerateCommand("summary", args),
  "check-log": checkLogCommand,
  "recover-state": recoverStateCommand,
  "stamp-held": (args) => heldCommand("stamp-held", args),
  "claim-held": (args) => heldCommand("claim-held", args),
  "resolve-held-thread": (args) => heldCommand("resolve-held-thread", args),
  "answer-summary-finding": (args) =>
    heldCommand("answer-summary-finding", args),
};

async function main(): Promise<number> {
  const [operation = "", ...args] = process.argv.slice(2);
  const handler = Object.hasOwn(handlers, operation)
    ? handlers[operation]
    : undefined;
  if (!handler)
    fail(
      2,
      "usage: portable.ts enumerate-threads|enumerate-summary [PR] [--bots-only] | check-log PATH | recover-state SOURCE DESTINATION | stamp-held [PR] | claim-held [PR] --key K --kind finding | resolve-held-thread [PR] --key K | answer-summary-finding [PR] --outcome OUTCOME --fingerprint KEY",
    );
  return handler(args);
}
if (import.meta.main) runMain("drive portable", main);
