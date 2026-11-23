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
/** Cancel every timer a run armed. */
export function clearProcessTimers(timers: ProcessTimers): void {
  for (const t of [timers.kill, timers.escalate, timers.stop])
    if (t) clearTimeout(t);
}

/** Inspect ignored diagnostics only when a parent requested forge accounting. */
export function accountingStderr(mode: "pipe" | "inherit" | "ignore" = "pipe") {
  return mode === "ignore" && process.env.JIG_FORGE_CALL_COUNT_FILE
    ? "pipe"
    : mode;
}

interface OutputOptions {
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
  maxBufferBytes?: number;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  onInheritedOutput?: (stream: "stdout" | "stderr", bytes: Buffer) => void;
  onChunk?: (
    stream: "stdout" | "stderr",
    bytes: number,
    captured: boolean,
  ) => void;
}

/** Pipe observed streams so they can be forwarded without being captured. */
export function observedStdio(
  options: OutputOptions & { stdin?: string },
): ("pipe" | "inherit" | "ignore")[] {
  const mode = (value: "pipe" | "inherit" | "ignore") =>
    value === "inherit" && options.onInheritedOutput !== undefined
      ? "pipe"
      : value;
  return [
    options.stdin === undefined ? "ignore" : "pipe",
    mode(options.stdout ?? "pipe"),
    mode(accountingStderr(options.stderr)),
  ];
}
interface OutputCancellation {
  timedOut(): boolean;
  signalTree(signal: NodeJS.Signals): void;
  settle(code: number): void;
  timers: ProcessTimers;
}

/** Give observed output written before exit a brief drain without waiting on other pipe writers. */
const OBSERVED_DRAIN_MS = 100;

function closeObservedOutput(
  child: ChildProcess,
  streams: NonNullable<ChildProcess["stdout"]>[],
  hasCapturedOutput: boolean,
  timers: ProcessTimers,
): void {
  if (streams.length === 0) return;
  child.once("exit", () => {
    // With inherited output the leader's exit ends its deadline. Preserve
    // that even when draining our extra pipes, and leave cancellation
    // escalation and regular captured streams to their existing handlers.
    if (!hasCapturedOutput) clearTimeout(timers.kill);
    const drain = setTimeout(() => {
      // A descendant can retain an inherited pipe after the leader exits.
      // We must bound that wait, but do not make a dropped diagnostic silent.
      for (const stream of streams) {
        console.error(
          "jig: inherited output forwarding ended before the stream closed; later diagnostics may be incomplete",
        );
        stream.destroy();
      }
    }, OBSERVED_DRAIN_MS);
    child.once("close", () => clearTimeout(drain));
  });
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
export function captureRun(
  child: ChildProcess,
  options: OutputOptions,
  control: Omit<OutputCancellation, "timers">,
) {
  const timers: ProcessTimers = {};
  const output = captureProcessOutput(child, options, { ...control, timers });
  return { timers, output };
}

function captureProcessOutput(
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
    const limit = options.maxBufferBytes ?? MAX_BUFFER_BYTES;
    let over = false;
    if (captured) {
      // The bound is enforced before appending: a chunk that crosses it keeps only what fits, so the result never holds more than the limit.
      let kept = text;
      if (bytes + length > limit) {
        over = true;
        kept = Buffer.from(text)
          .subarray(0, Math.max(0, limit - bytes))
          .toString("utf8")
          .replace(/\uFFFD+$/, "");
      }
      if (stream === "stdout") stdout += kept;
      else stderr += kept;
      bytes += over ? limit + 1 - bytes : length;
      options.onOutput?.(stream, kept);
    }
    options.onChunk?.(stream, length, captured);
    if (over || bytes > limit) overflow();
  };
  const observed: NonNullable<ChildProcess["stdout"]>[] = [];
  let hasCapturedOutput = false;
  for (const stream of ["stdout", "stderr"] as const) {
    const source = child[stream];
    if (source === null) continue;
    const observe = options.onInheritedOutput;
    if (options[stream] === "inherit" && observe !== undefined) {
      observed.push(source);
      source.on("data", (chunk: Buffer) => observe(stream, chunk));
      source.pipe(process[stream], { end: false });
    } else {
      hasCapturedOutput = true;
      source.setEncoding("utf8");
      source.on("data", (text: string) => receive(stream, text));
    }
  }
  closeObservedOutput(child, observed, hasCapturedOutput, cancellation.timers);
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
