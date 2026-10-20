/** Mirror the driver narrative to its durable log while preserving terminal output. */
import { driverRuntime } from "./runtime.ts";

import { errnoCode } from "./../../../../../shared/errors.ts";

import { DriverLog, type DriverLogLevel } from "./../driver-log.ts";

import { mkdirSync } from "node:fs";

import { dirname } from "node:path";

import { format } from "node:util";

const mayRotateDriverLog = (): boolean =>
  driverRuntime.driverLogRotates && driverRuntime.compromised === "";

export function startDriverLog(logPath: string): void {
  const unavailable = teeConsoleTo(logPath);
  console.error(
    unavailable === null
      ? `drive.ts: driver log → ${logPath}`
      : `drive.ts: driver log unavailable: ${unavailable}`,
  );
}

/**
 * Mirror everything this process writes to stdout/stderr into `logPath`,
 * append-only and BEST-EFFORT: the console stays authoritative, and a log
 * write that fails (disk full, directory vanished) must never take the drive
 * down with it — the same asymmetry `loopEconomy` documents for the report it
 * renders.
 *
 * TWO channels are wrapped, because under Bun they are disjoint: the console
 * methods write to the fd natively, BYPASSING the JS-level
 * `process.stdout.write` (measured — a stream-only tee logged nothing but its
 * own header), while the direct `process.stderr.write` call sites in
 * this file (the dirty-tree listing, the loop-economy epilogues) dispatch
 * through the assignable property and never touch console. Under Node the
 * channels are NOT disjoint — console methods dispatch THROUGH the patched
 * `stream.write` (measured on Node 24: an unguarded double tee appended
 * every console line twice) — so the console tee raises a reentrancy flag
 * and the stream tee skips its append while it is up, keeping every line
 * exactly-once on both supported runtimes. A child spawned
 * with inherited stdio writes to the fd itself and is NOT captured — that is
 * the pass, and it is deliberate (see the log's comment in `main`). Appends
 * are synchronous, so the tail survives the exit path without the async-pipe
 * truncation macOS is known for. Each line carries its time and level, and
 * the file rotates at a size bound (`lib/driver-log.ts`).
 *
 * Returns `null` once the tee is installed, or the reason there is no log.
 */
function teeConsoleTo(logPath: string): string | null {
  // An armed drive outlives the session that started it; once that session
  // closes the pipe, a console write fails with EPIPE. That one error is
  // absorbed whether or not the durable log starts: with a log it carries
  // the narrative from then on, and without one the drive still runs on.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err) => {
      if (errnoCode(err) !== "EPIPE") throw err;
    });
  }
  // Problems with the log are reported straight to the terminal, never
  // through the tee, which would only try the failing log again.
  const rawStderrWrite = process.stderr.write.bind(process.stderr);
  let starting = true;
  const driverLog = new DriverLog(logPath, {
    report: (message) => {
      if (!starting) rawStderrWrite(`drive.ts: warning: ${message}\n`);
    },
    // Several drivers can write this log (one that refuses to start writes
    // its refusal here); only the one holding the drive's locks rotates it.
    mayRotate: mayRotateDriverLog,
  });
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch (err) {
    return `cannot create ${dirname(logPath)} (${err instanceof Error ? err.message : String(err)})`;
  }
  driverLog.startRun(
    `── drive.ts pid ${process.pid} — driver narrative (pass output streams to the launching session) ──`,
  );
  starting = false;
  const unavailable = driverLog.firstProblem;
  if (unavailable !== null) {
    // Best-effort from the very first byte: an unwritable log — full disk, a
    // directory squatting on the path, permissions — must not stop the drive.
    // `startDriverLog` prints the one line that says so.
    return unavailable;
  }
  const append = (level: DriverLogLevel, text: string | Uint8Array): void =>
    driverLog.append(level, text);
  // Reentrancy flag for the Node path, where the original console methods
  // dispatch through the patched `stream.write` below — without it every
  // console line is appended twice. Console calls are synchronous, so a
  // plain boolean cannot interleave across writers.
  let teeingConsole = false;
  const consoleTee =
    (level: DriverLogLevel, original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      // `util.format` — the same formatter console.log itself applies —
      // so the durable copy keeps placeholders, object inspection and
      // Error stacks instead of degrading to `[object Object]`.
      append(level, `${format(...args)}\n`);
      teeingConsole = true;
      try {
        original(...args);
      } finally {
        teeingConsole = false;
      }
    };
  console.log = consoleTee("INFO", console.log.bind(console));
  console.error = consoleTee("WARN", console.error.bind(console));
  for (const [stream, level] of [
    [process.stdout, "INFO"],
    [process.stderr, "WARN"],
  ] as const) {
    const original = stream.write.bind(stream);
    const teed: typeof stream.write = (
      chunk: Uint8Array | string,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      if (!teeingConsole) append(level, chunk);
      return typeof encodingOrCb === "function"
        ? original(chunk, encodingOrCb)
        : original(chunk, encodingOrCb, cb);
    };
    stream.write = teed;
  }
  return null;
}
