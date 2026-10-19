// A command run with its output spooled to files, for the wrappers that show
// an agent a condensed or classified view of a gate's output and must keep
// the whole of it.
//
// Holding a command's output in memory bounds the wrapper by the command: a
// verbose test run or build can exhaust it and lose the very output a failure
// needs. So each stream goes to a file in a private temporary directory, read
// back in fixed-size chunks; only the lines a reader asks for, or one line,
// are ever held.
//
// Cancellation. On POSIX the command runs as the leader of its own process
// group, so a cancellation of the wrapper (SIGINT, SIGTERM, SIGHUP) reaches
// the command and every process it started: the signal goes to the group.
// The group then has a bounded grace period to end; whatever is still alive
// after it, the command or a descendant that ignored the signal, is killed.
// The caller still has what the command wrote. A command in a group of its
// own has no controlling terminal: reading the inherited standard input
// works, opening the terminal by name does not. On Windows the signal goes to
// the command alone, and its descendants are not reached.
//
// What it does not bound: how long a command that is never cancelled runs.
// The wrapper is transparent, like `nice` or `time`; the caller's own
// deadline (a CI job's timeout, an agent harness's) bounds the run.
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** A finished run: how it ended, and where its output is. */
export interface Spool {
  /** The exit code, or null when a signal ended the command. */
  code: number | null;
  /** The signal that ended the command, if one did. */
  signal: string | null;
  /** The signal that cancelled the wrapper while the command ran, if any. */
  interrupted: string | null;
  out: string;
  err: string;
  dir: string;
}

export interface RunOptions {
  stdin: "inherit" | "ignore";
  /** How long a cancelled command and its descendants have to end before
   * they are killed; ten seconds when unset. */
  graceMs?: number;
}

const CANCELS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const CHUNK = 64 * 1024;
/** The longest line `linesOf` holds: longer ones are not read, never cut. */
export const MAX_LINE = 4 * 1024 * 1024;
const GROUPS = process.platform !== "win32";

/** What a signal to a process group found. */
export type GroupState =
  /** A member took the signal. */
  | "signalled"
  /** Members exist and none could be signalled. macOS answers so for a group
   * whose members are exiting but not yet reaped, whoever owns them; a member
   * of another user gets the same answer. It is not proof the group is gone. */
  | "unsignalable"
  /** No process of the group is left. */
  | "gone";

/** The calls the group handling makes to the system; tests replace them to
 * produce answers a real process gives only in a race. */
export interface GroupIo {
  /** `process.kill`: throws with the system's error code. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Report a line to the operator. */
  warn: (line: string) => void;
  /** How long a killed group has to be reaped before it is reported. */
  reapMs: number;
}

const SYSTEM: GroupIo = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  warn: (line) => {
    process.stderr.write(line);
  },
  reapMs: 2_000,
};

/** Send a signal to a process group; 0 only asks whether it has members. */
export function signalGroup(
  pid: number,
  signal: NodeJS.Signals | 0,
  io: GroupIo = SYSTEM,
): GroupState {
  try {
    io.kill(-pid, signal);
    return "signalled";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "unsignalable";
    throw error;
  }
}

/** Wait until the group has no process left or the deadline passes. */
async function waitGone(
  pid: number,
  deadline: number,
  io: GroupIo,
): Promise<boolean> {
  while (signalGroup(pid, 0, io) !== "gone") {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
  return true;
}

/** Wait until the group has no process left or the deadline passes, then
 * kill what is left. A group that still answers after the kill is reported,
 * not assumed gone: its members are exiting slowly, or beyond this process's
 * reach. */
export async function reapGroup(
  pid: number,
  deadline: number,
  io: GroupIo = SYSTEM,
): Promise<void> {
  if (await waitGone(pid, deadline, io)) return;
  signalGroup(pid, "SIGKILL", io);
  if (!(await waitGone(pid, Date.now() + io.reapMs, io)))
    io.warn(
      `spooled-run: process group ${pid} still has members after SIGKILL\n`,
    );
}

/** Send a signal to the command's group, or to the command alone (`direct`)
 * where there are no groups or no member of the group took it. */
export function signalCommand(
  pid: number,
  name: NodeJS.Signals,
  direct: (name: NodeJS.Signals) => void,
  io: GroupIo = SYSTEM,
): void {
  if (!GROUPS || signalGroup(pid, name, io) !== "signalled") direct(name);
}

/** Run `command`, spooling its standard output and error to files. Throws
 * when the command cannot be started. */
export async function spooledRun(
  command: string[],
  options: RunOptions,
): Promise<Spool> {
  const dir = mkdtempSync(join(tmpdir(), "spooled-run-"));
  const out = join(dir, "stdout"),
    err = join(dir, "stderr");
  const outFd = openSync(out, "w"),
    errFd = openSync(err, "w");
  const graceMs = options.graceMs ?? 10_000;
  let interrupted: string | null = null;
  let deadline = Number.POSITIVE_INFINITY;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn(command, {
      stdin: options.stdin,
      stdout: outFd,
      stderr: errFd,
      detached: GROUPS,
    });
    const signal = (name: NodeJS.Signals) =>
      signalCommand(child.pid, name, (direct) => child.kill(direct));
    const forward = (name: NodeJS.Signals) => {
      interrupted ??= name;
      signal(name);
      if (escalation) return;
      deadline = Date.now() + graceMs;
      escalation = setTimeout(() => signal("SIGKILL"), graceMs);
    };
    for (const name of CANCELS) process.on(name, forward);
    try {
      await child.exited;
      if (interrupted && GROUPS) await reapGroup(child.pid, deadline);
    } finally {
      for (const name of CANCELS) process.off(name, forward);
      clearTimeout(escalation);
    }
    return {
      code: child.signalCode ? null : child.exitCode,
      signal: child.signalCode == null ? null : String(child.signalCode),
      interrupted,
      out,
      err,
      dir,
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

/** Remove a run's spool. */
export function removeSpool(spool: Spool): void {
  rmSync(spool.dir, { recursive: true, force: true });
}

/** Copy a spooled stream to a file descriptor, ending it with a line break
 * when it has text that does not, so what follows starts its own line. */
export function replayTo(path: string, fd: number): void {
  const source = openSync(path, "r");
  const buffer = Buffer.alloc(CHUNK);
  let last = "\n";
  try {
    for (
      let n = readSync(source, buffer);
      n > 0;
      n = readSync(source, buffer)
    ) {
      writeSync(fd, buffer, 0, n);
      last = String.fromCharCode(buffer[n - 1] ?? 10);
    }
  } finally {
    closeSync(source);
  }
  if (last !== "\n") writeSync(fd, "\n");
}

/** The last `count` lines of a spooled stream, each ending in a line break;
 * read backwards a chunk at a time, so only those lines are held. At most
 * `MAX_LINE` bytes are held: lines before that bound are replaced by one
 * line saying how many bytes were not shown, and a last line longer than the
 * bound by one saying so, so no line is cut. */
export function lastLinesOf(path: string, count: number): string {
  if (count === 0) return "";
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const from = tailStart(fd, size, count);
    if (size - from > MAX_LINE) return boundedTail(fd, size, from);
    const text = Buffer.alloc(size - from);
    readSync(fd, text, 0, text.length, from);
    const lines = text.toString("utf8");
    return lines === "" || lines.endsWith("\n") ? lines : `${lines}\n`;
  } finally {
    closeSync(fd);
  }
}

/** Where a stream's last `count` lines start, found by reading backwards a
 * chunk at a time; 0 when it holds fewer. */
function tailStart(fd: number, size: number, count: number): number {
  const buffer = Buffer.alloc(CHUNK);
  let breaks = 0;
  // A final line break ends the last line; it does not start another.
  const last = Buffer.alloc(1);
  if (size > 0) readSync(fd, last, 0, 1, size - 1);
  for (let at = last[0] === 10 ? size - 1 : size; at > 0; ) {
    const length = Math.min(CHUNK, at);
    at -= length;
    readSync(fd, buffer, 0, length, at);
    for (let k = length - 1; k >= 0; k--)
      if (buffer[k] === 10 && ++breaks >= count) return at + k + 1;
  }
  return 0;
}

/** The whole lines among a stream's last `MAX_LINE` bytes, after a line
 * naming the bytes from `from` that are not shown. */
function boundedTail(fd: number, size: number, from: number): string {
  const window = Buffer.alloc(MAX_LINE);
  const at = size - MAX_LINE;
  readSync(fd, window, 0, MAX_LINE, at);
  // The window's first line is whole when a line break precedes it;
  // otherwise it began before the window, and the first break ends it.
  const before = Buffer.alloc(1);
  readSync(fd, before, 0, 1, at - 1);
  const whole = before[0] === 10;
  const start = whole ? 0 : window.indexOf(10) + 1;
  if ((!whole && start === 0) || start >= MAX_LINE)
    return `[the last line is longer than ${MAX_LINE} bytes and is not shown]\n`;
  const lines = window.subarray(start).toString("utf8");
  return `[${at + start - from} earlier byte(s) not shown: the tail is longer than ${MAX_LINE} bytes]\n${lines.endsWith("\n") ? lines : `${lines}\n`}`;
}

/** The lines of a spooled stream, read a chunk at a time. A line longer
 * than `MAX_LINE` bytes throws rather than being cut, since a cut line can
 * drop the very text a reader matches. */
export function* linesOf(path: string): Generator<string> {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(CHUNK);
  const decoder = new StringDecoder("utf8");
  let partial = "";
  try {
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      const lines = (partial + decoder.write(buffer.subarray(0, n))).split(
        "\n",
      );
      partial = lines.pop() ?? "";
      // A line is checked whether a break has ended it or not yet.
      if (
        [...lines, partial].some((line) => Buffer.byteLength(line) > MAX_LINE)
      )
        throw new Error(
          `${path}: a line longer than ${MAX_LINE} bytes, which is not read`,
        );
      yield* lines;
    }
  } finally {
    closeSync(fd);
  }
  partial += decoder.end();
  if (partial !== "") yield partial;
}

/** How many lines a spooled stream holds; a last line without a break
 * counts. Counts line breaks, so no line is held. */
export function lineCount(path: string): number {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(CHUNK);
  let count = 0,
    last = 10;
  try {
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      for (let k = 0; k < n; k++) if (buffer[k] === 10) count++;
      last = buffer[n - 1] ?? 10;
    }
  } finally {
    closeSync(fd);
  }
  return last === 10 ? count : count + 1;
}
