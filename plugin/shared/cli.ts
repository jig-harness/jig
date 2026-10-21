/**
 * Small CLI primitives every skill's entry scripts share: exit-code plumbing,
 * the command-line boundary (`runMain`) and the few pure helpers every entry
 * point needs. Process spawning lives in `proc.ts`.
 */

import { setTimeout as sleepMs } from "node:timers/promises";
import { failureFields } from "./errors.ts";
import { guardStderr, log, logEnabled, setLogScript } from "./log.ts";

/**
 * Exit codes travel as exceptions so `main()` can return them in one place.
 * `cause` keeps the failure that led to the exit, for `JIG_LOG=debug`.
 */
export class ExitError extends Error {
  readonly code: number;
  constructor(code: number, message?: string, options?: { cause?: unknown }) {
    super(message ?? `exit ${code}`, options);
    this.name = "ExitError";
    this.code = code;
  }
}

/**
 * Print `lines` to stderr. A line that cannot be written is lost: the exit
 * that follows must not become a reporting error instead.
 */
function printLines(lines: readonly string[]): void {
  guardStderr();
  for (const line of lines) {
    try {
      console.error(line);
    } catch {
      // Standard error is unusable; the exit code still carries the outcome.
    }
  }
}

/** Print `lines` to stderr and throw the exit code. */
export function fail(code: number, ...lines: string[]): never {
  printLines(lines);
  throw new ExitError(code);
}

/**
 * `fail`, keeping `cause` (the error or failed child that led here) on the
 * exit, so the boundary can show it under `JIG_LOG=debug`.
 */
export function failFrom(
  cause: unknown,
  code: number,
  ...lines: string[]
): never {
  printLines(lines);
  throw new ExitError(code, undefined, { cause });
}

/**
 * The command-line boundary. Run an async `main` and translate its outcome
 * into the process exit code — via `process.exitCode`, never
 * `process.exit()`, so pending stdout writes to a pipe are flushed rather
 * than truncated. An unexpected error is reported as `<name>: <message>`;
 * under `JIG_LOG=debug` every failure, an `ExitError` included, is also
 * reported with its stack, its causes and a failed child's error output.
 */
export function runMain(name: string, main: () => Promise<number>): void {
  setLogScript(name);
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      // The exit code first: a report that fails must not change it.
      process.exitCode = e instanceof ExitError ? e.code : 1;
      try {
        if (e instanceof ExitError) {
          if (logEnabled("debug"))
            log.debug(`exit ${e.code}`, failureFields(e));
          return;
        }
        log.error(e instanceof Error ? e.message : String(e));
        if (logEnabled("debug")) log.debug("stack", failureFields(e));
      } catch {
        // The logger does not throw; a getter on the error itself might.
      }
    },
  );
}

/** Digits-only, per the bash `case` guards on PR numbers and counters. */
export function isDigits(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

/**
 * `isDigits`, plus a bound that keeps the result safe to hand to
 * `Number.parseInt` without precision loss or an `Infinity` result.
 * `isDigits` alone accepts an arbitrarily long run of digits —
 * `current-round.ts` learned this the hard way (`'9'.repeat(400)` parses to
 * `Infinity`, which a `round >= N` cutoff then arms off) and fixed its own
 * `isRoundOrdinal` with this exact pairing, without exporting it — so the
 * next script accepting a bare ordinal (`triage-ladder.ts --round`) re-invented
 * the narrower, unsafe `isDigits`-only check instead of reusing it. Exported
 * here, the one shared primitives module, so a third script has this to reach
 * for instead of a third variant.
 */
export function isSafeDigits(s: string): boolean {
  return isDigits(s) && Number.isSafeInteger(Number(s));
}

/**
 * An environment variable read the way the bash predecessors' `${VAR:-def}`
 * read it: UNSET and EMPTY both take the default. `?? def` does not — it keeps
 * `''`, which every consumer here then rejects as non-numeric, so a variable
 * exported empty by optional templating (`REFLECT_THRESHOLD="$SOMETHING"` with
 * `SOMETHING` unset) turned a documented default into a usage exit 2. Same
 * semantics `readTimeoutEnv` in proc.ts already applies to GH_CALL_TIMEOUT
 * — those were the only two `${VAR:-…}` reads in the ported surface, and this
 * is now the other one.
 */
export function envOrDefault(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? def : raw;
}

/** Wait for the delay, or return normally when the caller aborts it. */
export async function sleep(
  seconds: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await sleepMs(
      seconds * 1000,
      undefined,
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  }
}

/**
 * Quote a string so POSIX `sh`/`bash` reads it back as this one literal — for
 * rendering a suggested command in diagnostics. A path or prompt CAN contain
 * an apostrophe; the `'\''` idiom survives it.
 */
export function shellQuote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9_\-./:=+@%^]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Read all of stdin (the reply-body channel). Byte-faithful: no trailing
 * newline is ever stripped — the bash original needed a sentinel-char dance to
 * keep a deliberate trailing blank line alive through `$(cat)`, which strips
 * ALL trailing newlines; reading the stream directly has no such step to
 * defend against.
 */
export async function readStdinAll(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}
