// The log side of `foreground-wait.ts`: relaying a launch's output to `wait`,
// reporting a lost launch with the command's last output, and refusing a
// harness whose tool calls end the processes they start.
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { detectHarness } from "../../../../shared/harness.ts";

/** Most log bytes one `wait` relays; older unseen output is summarised. */
const LOG_CAP_BYTES = 256 * 1024;
/** Least log tail a lost launch's report shows, repeating relayed bytes. */
const LOST_TAIL_BYTES = 4 * 1024;
/** How long a relayed write may make no progress before the relay gives up. */
const STDOUT_STALL_MS = 30_000;
/** Total time one relayed write may take, however steadily it progresses. */
const STDOUT_RELAY_MAX_MS = 60_000;

/** `launch`'s exit when the harness ends a tool call's processes as it returns. */
const UNSUPPORTED_HARNESS_EXIT = 4;

/**
 * Codex's default Linux sandbox ends every process a tool call started when
 * that call returns, and a runner's survival cannot be verified from inside
 * it, so Jig refuses the foreground wait there as a conservative policy. Name
 * Codex's own long-running command session; null under any other harness.
 * `CODEX_HOME` only selects a configuration directory, so alone it does not
 * mark a Codex tool call.
 */
export function refuseUnderCodex(): number | null {
  if (detectHarness()?.name !== "codex") return null;
  const marker = Object.keys(process.env).find(
    (name) => name.startsWith("CODEX_") && name !== "CODEX_HOME",
  );
  if (marker === undefined) return null;
  console.error(
    `foreground-wait: not under Codex (${marker} is set) — Codex's sandbox ends the processes a tool call started when the call returns, so the runner would be lost before \`wait\`; Jig refuses rather than rely on it surviving. Run the command itself through \`exec_command\` with a \`yield_time_ms\` below the call ceiling, then poll that session with \`write_stdin\` (empty input) until it exits; where neither tool is exposed, run the command in one foreground call and, if it cannot finish within the ceiling, stop and say so. Nothing was started`,
  );
  return UNSUPPORTED_HARNESS_EXIT;
}

/**
 * Report a launch whose runner was lost: at least the log's last
 * `LOST_TAIL_BYTES`, repeating what an earlier `wait` relayed, or all the
 * unseen output when there is more; then the verdict.
 */
export function reportLost(dir: string): void {
  const log = join(dir, "log");
  if (!existsSync(log)) {
    console.log(
      "foreground-wait: no log was written; the runner may have been lost before it started the command",
    );
  } else {
    const size = statSync(log).size;
    if (size === 0) console.log("foreground-wait: the command wrote no output");
    else if (size - logCursor(dir, size) >= LOST_TAIL_BYTES) relayLog(dir);
    else repeatLogTail(dir, size);
  }
  console.log(
    "foreground-wait: the runner was lost before it published a result; no recorded process is alive",
  );
}

/** How far earlier waits relayed the log; 0 when the cursor is unusable. */
function logCursor(dir: string, size: number): number {
  const seen = Number.parseInt(
    existsSync(join(dir, "log.cursor"))
      ? readFileSync(join(dir, "log.cursor"), "utf8")
      : "0",
    10,
  );
  return Number.isInteger(seen) && seen >= 0 && seen <= size ? seen : 0;
}

/** Relay the log bytes not yet shown, bounded, advancing a per-launch cursor. */
export function relayLog(dir: string): void {
  if (!existsSync(join(dir, "log"))) return;
  const size = statSync(join(dir, "log")).size;
  let start = logCursor(dir, size);
  if (size - start > LOG_CAP_BYTES) {
    const omitted = size - LOG_CAP_BYTES - start;
    console.log(`[foreground-wait: ${omitted} earlier log bytes omitted]`);
    start = size - LOG_CAP_BYTES;
  }
  const bytes = readLogRange(dir, start, size);
  writeStdoutSync(bytes);
  writeFileSync(join(dir, "log.cursor"), `${start + bytes.length}\n`);
}

/** The log's bytes from `start` up to `end`, fewer when it is shorter. */
function readLogRange(dir: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(join(dir, "log"), "r");
  let got = 0;
  try {
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  return buf.subarray(0, got);
}

/** Show the log's last bytes, relayed or not, and mark all of it relayed. */
function repeatLogTail(dir: string, size: number): void {
  const start = Math.max(0, size - LOST_TAIL_BYTES);
  const bytes = readLogRange(dir, start, size);
  // Synchronous throughout, so the header cannot be overtaken by the tail.
  writeStdoutSync(
    Buffer.from(
      `[foreground-wait: the command's last output${start > 0 ? `, its final ${bytes.length} bytes` : ""}]\n`,
    ),
  );
  writeStdoutSync(bytes);
  if (bytes.at(-1) !== 0x0a) writeStdoutSync(Buffer.from("\n"));
  writeFileSync(join(dir, "log.cursor"), `${start + bytes.length}\n`);
}

/**
 * Write all of `bytes` to stdout before returning. `process.stdout.write` on a
 * pipe is asynchronous under Bun: the `console.log` lines that follow overtook
 * its tail, and `process.exit` then dropped whatever had not drained — on Linux
 * under load, the relayed tail including the truncation marker.
 */
export function writeStdoutSync(bytes: Uint8Array): void {
  let off = 0;
  const startedAt = Date.now();
  let lastProgress = startedAt;
  while (off < bytes.length) {
    try {
      const n = writeSync(1, bytes, off, bytes.length - off);
      off += n;
      if (n > 0) lastProgress = Date.now();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      // A non-blocking stdout whose reader is behind: back off and retry. The
      // sleep blocks the event loop, so the stall is bounded here — a reader
      // that stays open but stops draining must fail the relay, not wedge it
      // past the wait budget with the cancellation handlers unable to run.
      if (Date.now() - lastProgress > STDOUT_STALL_MS) {
        throw new Error(
          `foreground-wait: stdout reader made no progress for ${STDOUT_STALL_MS}ms`,
          { cause: err },
        );
      }
      // Slow-but-steady progress resets the stall clock, so the relay also has
      // an overall budget: a reader taking a few KiB per interval must not
      // keep this synchronous loop running past the caller's wait budget.
      if (Date.now() - startedAt > STDOUT_RELAY_MAX_MS) {
        throw new Error(
          `foreground-wait: stdout relay exceeded ${STDOUT_RELAY_MAX_MS}ms`,
          { cause: err },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
