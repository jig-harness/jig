import { FORGE_ACCOUNTING_UNAVAILABLE } from "./trace.ts";
/** How much of a failed child's error output `RunResult.stderrTail` keeps. */
export const STDERR_TAIL_BYTES = 4 * 1024;

/** The last `STDERR_TAIL_BYTES` of `text`, cut on a character boundary. */
export function lastBytes(text: string): string {
  if (text.length <= STDERR_TAIL_BYTES / 4) return text;
  const bytes = Buffer.from(text);
  if (bytes.length <= STDERR_TAIL_BYTES) return text;
  return bytes
    .subarray(bytes.length - STDERR_TAIL_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
}

/** Maximum captured stdout and stderr bytes before the command is cancelled. */
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
import type { ChildProcess } from "node:child_process";

/** Timers share a lifecycle with captured output and cancellation settlement. */
export interface ProcessTimers {
  kill?: NodeJS.Timeout;
  escalate?: NodeJS.Timeout;
  stop?: NodeJS.Timeout;
}
/** Inspect ignored diagnostics only when a parent requested forge accounting. */
export function accountingStderr(mode: "pipe" | "inherit" | "ignore" = "pipe") {
  return mode === "ignore" && process.env.JIG_FORGE_CALL_COUNT_FILE
    ? "pipe"
    : mode;
}

interface OutputOptions {
  stderr?: "pipe" | "inherit" | "ignore";
  maxBufferBytes?: number;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  onChunk?: (
    stream: "stdout" | "stderr",
    bytes: number,
    captured: boolean,
  ) => void;
}
interface OutputCancellation {
  timedOut(): boolean;
  signalTree(signal: NodeJS.Signals): void;
  settle(code: number): void;
  timers: ProcessTimers;
}

/** A bounded marker scan relays accounting failure without retaining diagnostics. */
function accountingOutput(): (text: string) => void {
  const accounting = Boolean(process.env.JIG_FORGE_CALL_COUNT_FILE);
  let window = "";
  let reported = false;
  return (text) => {
    if (!accounting || reported) return;
    const inspected = window + text;
    if (inspected.includes(FORGE_ACCOUNTING_UNAVAILABLE)) {
      console.error(FORGE_ACCOUNTING_UNAVAILABLE);
      reported = true;
    }
    window = inspected.slice(-(FORGE_ACCOUNTING_UNAVAILABLE.length - 1));
  };
}

/** Bounded capture keeps diagnostics after acceptance stops and ends runaway output. */
export function captureProcessOutput(
  child: ChildProcess,
  options: OutputOptions,
  cancellation: OutputCancellation,
) {
  let stdout = "";
  let stderr = "";
  let tail = "";
  let bytes = 0;
  let bufferExceeded = false;
  const inspectAccounting = accountingOutput();
  const overflow = (): void => {
    if (bufferExceeded || cancellation.timedOut()) return;
    bufferExceeded = true;
    if (cancellation.timers.kill) clearTimeout(cancellation.timers.kill);
    cancellation.signalTree("SIGTERM");
    cancellation.timers.escalate = setTimeout(() => {
      cancellation.signalTree("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      cancellation.settle(1);
    }, 2000);
  };
  const receive = (stream: "stdout" | "stderr", text: string): void => {
    if (stream === "stderr") inspectAccounting(text);
    // Ignored output never contributes to captured diagnostics or their budget.
    // Keep only enough overlap to recognize a marker split across chunks.
    if (stream === "stderr" && options.stderr === "ignore") {
      return;
    }
    if (stream === "stderr") tail = lastBytes(tail + text);
    const captured = !(bufferExceeded || cancellation.timedOut());
    const length = Buffer.byteLength(text);
    if (captured) {
      if (stream === "stdout") stdout += text;
      else stderr += text;
      bytes += length;
      options.onOutput?.(stream, text);
    }
    options.onChunk?.(stream, length, captured);
    if (bytes > (options.maxBufferBytes ?? MAX_BUFFER_BYTES)) overflow();
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => receive("stdout", text));
  child.stderr?.on("data", (text: string) => receive("stderr", text));
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get tail() {
      return tail;
    },
    get bufferExceeded() {
      return bufferExceeded;
    },
  };
}
