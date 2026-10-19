/**
 * The plugin's logger: diagnostics for a person reading a failed run, written
 * to standard error only, so a script's standard output stays its answer.
 *
 * `JIG_LOG` sets the least severe level written (`error`, `warn`, `info`,
 * `debug`; default `warn`, and an unknown value reads as the default).
 * `JIG_LOG_FORMAT` sets the shape: `text` (the default) writes
 * `<script>: <message>`, the look the scripts' own messages already have,
 * with any fields after it; `json` writes one object per line with the time,
 * level, script, message and fields. Both are read on every call, so a test
 * or a caller can change them for one run.
 */
import { basename, extname } from "node:path";

export type Level = "error" | "warn" | "info" | "debug";
export type Fields = Readonly<Record<string, unknown>>;

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function isLevel(value: string): value is Level {
  return Object.hasOwn(RANK, value);
}

/** The least severe level `JIG_LOG` lets through. */
function logLevel(env: NodeJS.ProcessEnv = process.env): Level {
  const raw = (env.JIG_LOG ?? "").trim().toLowerCase();
  return isLevel(raw) ? raw : "warn";
}

function logFormat(env: NodeJS.ProcessEnv): "text" | "json" {
  return (env.JIG_LOG_FORMAT ?? "").trim().toLowerCase() === "json"
    ? "json"
    : "text";
}

let script = basename(process.argv[1] ?? "jig", extname(process.argv[1] ?? ""));

/**
 * The name every line is attributed to. Defaults to the entry script's file
 * name; the command-line boundary sets the name it was given.
 */
export function setLogScript(name: string): void {
  script = name;
}

/** Whether a line at `level` would be written now. */
export function logEnabled(level: Level): boolean {
  return RANK[level] <= RANK[logLevel()];
}

/** How many causes deep an error is followed, so a cycle cannot recurse. */
export const MAX_CAUSE_DEPTH = 8;

/** An `Error` as plain data, its cause chain included up to a bound. */
function plain(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error)) return value;
  return {
    name: value.name,
    message: value.message,
    ...(value.stack === undefined ? {} : { stack: value.stack }),
    ...(value.cause === undefined || depth >= MAX_CAUSE_DEPTH
      ? {}
      : { cause: plain(value.cause, depth + 1) }),
  };
}

/**
 * JSON for any value: a repeated object becomes `"[circular]"`, a BigInt
 * its digits, a function or symbol its `String()`. Never throws.
 */
function toJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "function" || typeof v === "symbol") return String(v);
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
    return text ?? String(value);
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function shownText(value: unknown): string {
  if (value instanceof Error)
    return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    return String(value);
  return toJson(plain(value));
}

/**
 * Short fields follow the message as ` key=value`; a field with several
 * lines, and every field after it, goes below as an indented block.
 */
function textFields(fields: Fields): string {
  let out = "";
  let block = false;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const shown = shownText(value);
    if (!block && !shown.includes("\n")) {
      out += ` ${key}=${shown}`;
      continue;
    }
    block = true;
    const body = shown.replace(/\n+$/, "").replaceAll("\n", "\n    ");
    out += `\n  ${key}:\n    ${body}`;
  }
  return out;
}

function format(level: Level, message: string, fields?: Fields): string {
  if (logFormat(process.env) === "json") {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields ?? {}))
      extra[key] = plain(value);
    // Fields first, so none can overwrite the fixed keys.
    return toJson({
      ...extra,
      time: new Date().toISOString(),
      level,
      script,
      message,
    });
  }
  return `${script}: ${message}${textFields(fields ?? {})}`;
}

let guardingStderr = false;

/**
 * Standard error carries diagnostics only, and a write to it can fail after
 * `write` has returned: a closed pipe (the session that started the script
 * has gone) reports EPIPE, a full or failing device ENOSPC or EIO, on the
 * stream's `error` event, which unhandled ends the process. Once guarded,
 * such a failure loses the line and nothing else. The logger guards before
 * its first line, the command-line boundary before it prints a refusal.
 */
export function guardStderr(): void {
  if (guardingStderr) return;
  guardingStderr = true;
  process.stderr.on("error", () => {
    // A diagnostic that cannot be written is lost; the run's outcome is not.
  });
}

/**
 * Write one line. A logger that throws would turn a diagnostic into a new
 * failure, so nothing here does: a line that cannot be written is lost.
 */
function write(level: Level, message: string, fields?: Fields): void {
  try {
    if (!logEnabled(level)) return;
    guardStderr();
    process.stderr.write(`${format(level, message, fields)}\n`);
  } catch {
    // Standard error itself is unusable; there is nowhere left to report it.
  }
}

export const log = {
  error: (message: string, fields?: Fields): void =>
    write("error", message, fields),
  warn: (message: string, fields?: Fields): void =>
    write("warn", message, fields),
  info: (message: string, fields?: Fields): void =>
    write("info", message, fields),
  debug: (message: string, fields?: Fields): void =>
    write("debug", message, fields),
};
