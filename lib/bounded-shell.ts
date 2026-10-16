#!/usr/bin/env bun
/**
 * A shell command run with a deadline. Bun's shell neither times out nor can
 * be cancelled, and it throws, rather than exits, on a command it cannot
 * parse; a gate that awaits it in-process therefore hangs on a check that
 * never ends and stops at the first unparsable one. So the command runs in a
 * child Bun process of its own (this file, run as a script), and the caller
 * ends that child's whole tree when the command finishes, when the deadline
 * passes, or when the caller itself is signalled. On POSIX the tree is a
 * process group of its own. Windows has no process groups and cannot reach
 * the descendants of a process that has exited, so there the child reports
 * the command's exit code over IPC and stays alive as the tree's root until
 * `taskkill /T` ends it with every descendant. A command that cannot be
 * parsed exits `CANNOT_PARSE` with `CANNOT_PARSE_MARK` on stderr. On POSIX
 * the child runs the command through `bun exec`, which streams its output
 * rather than keeping it, so no process holds more of it than the caller
 * keeps; on Windows the child runs it in-process and keeps all of it.
 */
import { $ } from "bun";
import { cli } from "./cli.ts";
import { isRecord } from "./record.ts";

/** A setting or argument the caller supplied that cannot be used. */
class InputError extends Error {}

/** The child's exit code, and the start of its stderr line, for an unparsable command. */
const CANNOT_PARSE = 126;
const CANNOT_PARSE_MARK = "bun: cannot parse the command: ";

/** The seconds a command may run when the caller sets no deadline. */
const DEFAULT_TIMEOUT_SEC = 1800;
/** How much of each stream is kept for the caller; the rest is shown, not kept. */
const KEEP_BYTES = 64 * 1024;
const GRACE_MS = 2000;

/** The deadline from `$JIG_COMMAND_TIMEOUT_SEC`, a positive number of seconds. */
export function timeoutSec(env = process.env): number {
  const raw = env.JIG_COMMAND_TIMEOUT_SEC;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_SEC;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new InputError(
      `JIG_COMMAND_TIMEOUT_SEC must be a positive number of seconds, not "${raw}"`,
    );
  return value;
}

export interface ShellResult {
  /** The command's exit code; -1 when it was killed. */
  exitCode: number;
  /** The last bytes of its output, at most 64 KiB of each. */
  stdout: string;
  stderr: string;
  /** More output came than was kept: `stdout`/`stderr` is only its tail. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  /** The shell could not parse the command, so it never started. */
  cannotParse: boolean;
}

const live = new Set<number>();
const POSIX = process.platform !== "win32";

/** End the tree rooted at `pid`: its process group on POSIX, `taskkill /T` on Windows. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!POSIX) {
    // A tree already gone is the outcome wanted, so the result is not read.
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

let forwarding = false;
/** A signal to this process is passed on to every live command's group, then re-raised. */
function forwardSignals(): void {
  if (forwarding) return;
  forwarding = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      for (const pid of live) killGroup(pid, "SIGKILL");
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  echo: ((chunk: Uint8Array) => void) | undefined,
): Promise<{ text: string; truncated: boolean }> {
  let kept = new Uint8Array(0);
  let truncated = false;
  for await (const chunk of stream) {
    echo?.(chunk);
    const joined = new Uint8Array(kept.length + chunk.length);
    joined.set(kept);
    joined.set(chunk, kept.length);
    if (joined.length > KEEP_BYTES) truncated = true;
    kept = truncated ? joined.slice(-KEEP_BYTES) : joined;
  }
  return { text: new TextDecoder().decode(kept), truncated };
}

/**
 * Run `command` through Bun's shell from `cwd`, killed with its descendants
 * once `timeoutSec` passes. With `echo`, its output is shown as it runs.
 */
export async function runShell(
  command: string,
  {
    cwd,
    timeoutSec: seconds = timeoutSec(),
    echo = false,
  }: { cwd: string; timeoutSec?: number; echo?: boolean },
): Promise<ShellResult> {
  forwardSignals();
  const report = Promise.withResolvers<number>();
  const child = Bun.spawn([process.execPath, import.meta.path, command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: POSIX,
    ...(POSIX
      ? {}
      : {
          ipc: (message: unknown) => {
            if (isRecord(message) && typeof message.exitCode === "number")
              report.resolve(message.exitCode);
          },
        }),
  });
  live.add(child.pid);
  let timedOut = false;
  let escalate: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, "SIGTERM");
    escalate = setTimeout(() => killGroup(child.pid, "SIGKILL"), GRACE_MS);
  }, seconds * 1000);
  const output = Promise.all([
    drain(child.stdout, echo ? (c) => process.stdout.write(c) : undefined),
    drain(child.stderr, echo ? (c) => process.stderr.write(c) : undefined),
  ]);
  // The command's end, not its output's: a descendant it left running can
  // hold the pipes open, and ending the tree is what closes them.
  const ended = await (POSIX
    ? child.exited.then((code) => ({ code, reported: true }))
    : Promise.race([
        report.promise.then((code) => ({ code, reported: true })),
        child.exited.then((code) => ({ code, reported: false })),
      ]));
  killGroup(child.pid, "SIGKILL");
  const [stdout, stderr] = await output;
  await child.exited;
  clearTimeout(timer);
  if (escalate) clearTimeout(escalate);
  live.delete(child.pid);
  const killed =
    timedOut || !ended.reported || (POSIX && child.signalCode !== null);
  return {
    exitCode: killed ? -1 : ended.code,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    timedOut,
    cannotParse:
      ended.code === CANNOT_PARSE && stderr.text.includes(CANNOT_PARSE_MARK),
  };
}

/** Run the command; on Windows, report its exit code and wait to be ended with the tree. */
async function main(command: string): Promise<number> {
  let code: number;
  try {
    // Building the shell promise parses the command without running it.
    const shell = $`${{ raw: command }}`.nothrow();
    // Bun's shell API keeps all of a command's output in memory until it
    // ends; `bun exec` runs the same shell and streams the output instead.
    // On Windows the descendants of the exited `bun exec` would escape
    // `taskkill /T`, so the command runs in this process there.
    code = POSIX
      ? await Bun.spawn([process.execPath, "exec", command], {
          stdio: ["ignore", "inherit", "inherit"],
        }).exited
      : (await shell).exitCode;
  } catch (error) {
    console.error(
      `${CANNOT_PARSE_MARK}${error instanceof Error ? error.message : String(error)}`,
    );
    code = CANNOT_PARSE;
  }
  if (POSIX || !process.send) return code;
  // Stay alive as the tree's root until the caller ends the tree, or leaves.
  const alive = setInterval(() => undefined, 60_000);
  process.on("disconnect", () => clearInterval(alive));
  process.send({ exitCode: code });
  return code;
}

if (import.meta.main) cli(() => main(process.argv[2] ?? ""));
