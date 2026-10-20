/** Opt-in local timing spans. Call sites supply metadata, never command payloads. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { errnoCode, swallow } from "./errors.ts";

type Attributes = Record<string, string | number | boolean | null | undefined>;
interface Context {
  traceId: string;
  spanId: string;
}
const context = new AsyncLocalStorage<Context>();
const propagation = new AsyncLocalStorage<boolean>();
let root: Context | undefined;

/** Keep an enumerated child environment free of ambient trace settings. */
export function withoutTracePropagation<T>(operation: () => T): T {
  return propagation.run(false, operation);
}

function enabled(): boolean {
  return process.env.JIG_TRACE === "1" || Boolean(process.env.JIG_TRACE_FILE);
}

function inherited(): Context {
  if (root) return root;
  const match =
    /^00-((?!0{32}-)[a-f0-9]{32})-((?!0{16}-)[a-f0-9]{16})-[a-f0-9]{2}$/i.exec(
      process.env.TRACEPARENT ?? "",
    );
  root = match
    ? { traceId: match[1] ?? "", spanId: match[2] ?? "" }
    : { traceId: randomBytes(16).toString("hex"), spanId: "" };
  return root;
}

/** The default trace root is independent of the consumer repository. */
function traceDirectory(): string {
  return join(homedir(), ".local", "state", "jig", "traces");
}

/** Propagate the current span even when the caller supplies a filtered environment. */
export function traceEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  if (propagation.getStore() === false || !enabled()) return env;
  const current = context.getStore() ?? inherited();
  return {
    ...env,
    JIG_TRACE: process.env.JIG_TRACE,
    JIG_TRACE_FILE: process.env.JIG_TRACE_FILE
      ? resolve(process.env.JIG_TRACE_FILE)
      : process.env.JIG_TRACE_FILE,
    TRACEPARENT: `00-${current.traceId}-${current.spanId || randomBytes(8).toString("hex")}-01`,
  };
}

/** JSON lines are appended synchronously so process exit cannot discard settled spans.
 * Diagnostics must never change an operation's result, including on a full disk. */
export async function span<T>(
  name: string,
  attrs: Attributes,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!enabled()) return fn();
  const parent = context.getStore() ?? inherited();
  const current = {
    traceId: parent.traceId,
    spanId: randomBytes(8).toString("hex"),
  };
  const start = new Date();
  const clock = performance.now();
  let status = "ok";
  try {
    return await context.run(current, fn);
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    try {
      const file =
        process.env.JIG_TRACE_FILE ||
        join(
          traceDirectory(),
          start.toISOString().slice(0, 10),
          `${current.traceId}.jsonl`,
        );
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(
        file,
        `${JSON.stringify({
          trace_id: current.traceId,
          span_id: current.spanId,
          parent_id: parent.spanId || null,
          name,
          start: start.toISOString(),
          duration_ms: performance.now() - clock,
          status,
          attrs,
        })}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      swallow(
        error,
        "tracing could not append a settled span; preserving operation result",
      );
    }
  }
}

/** Trace days are machine-global, so removal tolerates a competing reaper. */
function removeTraceDay(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/** A concurrent reaper may have removed the day first; that is not a failure. */
function removeDay(
  remove: (path: string) => void,
  path: string,
  failures: string[],
): void {
  try {
    remove(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      failures.push(`could not remove trace day ${basename(path)}`);
  }
}

/** Expire complete UTC trace days older than fourteen days; dry runs only report. */
export function reapTraceDays(
  del: boolean,
  now = Date.now(),
  directory = traceDirectory(),
  remove: (path: string) => void = removeTraceDay,
): { days: string[]; failures: string[] } {
  const days: string[] = [];
  const failures: string[] = [];
  const cutoff = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
  try {
    // Oldest first, so failures report in the same order on every filesystem.
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.name) ||
        entry.name >= cutoff
      )
        continue;
      const timestamp = Date.parse(`${entry.name}T00:00:00Z`);
      if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== entry.name
      )
        continue;
      days.push(entry.name);
      if (del) removeDay(remove, join(directory, entry.name), failures);
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      failures.push("could not enumerate trace days");
  }
  return { days, failures };
}

/** Command timing carries only the executable basename and execution outcome. */
function traceCommand<T extends { code: number; timedOut: boolean }>(
  name: string,
  executable: string,
  timeoutSec: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const attrs = {
    command: executable.split(/[\\/]/).pop() ?? "",
    timeout_sec: timeoutSec,
    exit_code: 0,
    timed_out: false,
  };
  return span(name, attrs, async () => {
    const result = await fn();
    attrs.exit_code = result.code;
    attrs.timed_out = result.timedOut;
    return result;
  });
}

/** Shared gh boundary keeps its effective deadline and span metadata together. */
function traceGhCall<
  T extends { code: number; timedOut: boolean },
  O extends { timeoutSec?: number },
>(
  args: string[],
  opts: O,
  envDeadline: number,
  run: (argv: string[], options: O) => Promise<T>,
): Promise<T> {
  const deadline =
    opts.timeoutSec === undefined
      ? envDeadline
      : Math.max(1, Math.min(envDeadline, opts.timeoutSec));
  return traceCommand("ghCall", "gh", deadline, () =>
    run(args, { ...opts, timeoutSec: deadline }),
  );
}

/** Adapt a process runner once, preserving its options and complete result type. */
export function traceRunner<
  T extends { code: number; timedOut: boolean },
  O extends { timeoutSec?: number },
>(
  fn: (argv: string[], opts: O) => Promise<T>,
  defaults: O,
): (argv: string[], opts?: O) => Promise<T> {
  return (argv, opts = defaults) =>
    traceCommand("run", argv[0] ?? "", opts.timeoutSec, () => fn(argv, opts));
}

/** Adapt the gh boundary without copying its deadline or span bookkeeping. */
export function traceGhRunner<
  T extends { code: number; timedOut: boolean },
  O extends { timeoutSec?: number },
>(
  run: (argv: string[], opts: O) => Promise<T>,
  timeout: () => number,
  defaults: O,
): (args: string[], opts?: O) => Promise<T> {
  return (args, opts = defaults) => traceGhCall(args, opts, timeout(), run);
}
