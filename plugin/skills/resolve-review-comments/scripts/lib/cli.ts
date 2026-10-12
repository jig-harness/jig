/**
 * Small CLI primitives shared by this skill's scripts: exit-code plumbing and
 * the few pure helpers every entry point needs. Process spawning lives in
 * `proc.ts`.
 *
 * A PARITY COPY of the same-named module in drive-pr's `scripts/lib/`, not an
 * import of it, deliberately — the same boundary `proc.ts` documents in its
 * header: this skill is distributed on its own (engineering-standards sync),
 * so its scripts must resolve entirely inside the skill directory.
 */

import { setTimeout as sleepMs } from "node:timers/promises";

/** Exit codes travel as exceptions so `main()` can return them in one place. */
export class ExitError extends Error {
  readonly code: number;
  constructor(code: number, message?: string) {
    super(message ?? `exit ${code}`);
    this.code = code;
  }
}

/** Print `lines` to stderr and throw the exit code. */
export function fail(code: number, ...lines: string[]): never {
  for (const line of lines) console.error(line);
  throw new ExitError(code);
}

/**
 * Run an async `main` and translate its outcome into the process exit code —
 * via `process.exitCode`, never `process.exit()`, so pending stdout writes to
 * a pipe are flushed rather than truncated.
 */
export function runMain(name: string, main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      if (e instanceof ExitError) {
        process.exitCode = e.code;
        return;
      }
      console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
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
 * semantics `readTimeoutEnv` in lib/proc.ts already applies to GH_CALL_TIMEOUT
 * — those were the only two `${VAR:-…}` reads in the ported surface, and this
 * is now the other one.
 */
export function envOrDefault(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? def : raw;
}

export async function sleep(seconds: number): Promise<void> {
  await sleepMs(seconds * 1000);
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
