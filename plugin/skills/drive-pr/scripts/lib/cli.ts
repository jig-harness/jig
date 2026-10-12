/**
 * Small CLI primitives shared by every drive-pr script: exit-code plumbing,
 * argv validation helpers, and the few pure utilities that would otherwise be
 * copy-pasted per script. Process spawning lives in `proc.ts`; durable-state
 * concerns live under `state/`.
 */

import { fstatSync, statSync } from "node:fs";
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
 * A full, lowercase, 40-character SHA-1 hex string — the exact grammar every
 * documented caller derives via `git rev-parse HEAD` (never `--short`, never an
 * abbreviation). Rejecting anything looser than that at the argument boundary
 * is what closes a whole class of malformed-input, not just CR/LF: a value this
 * permits can never contain a newline (it fails-closed the shared state file on
 * the next read) or a backtick/pipe (it corrupts the handoff's markdown table,
 * which renders both SHAs and actor ids inside backtick code spans and
 * pipe-delimited rows).
 */
export function isGitSha(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/**
 * `signal` lets a caller wake this early rather than waiting out the full
 * delay — `drive.ts`'s quota-wall sleep passes one so a lock takeover
 * observed mid-sleep interrupts it immediately instead of up to six hours
 * late. Resolves normally either way: an abort is a caller
 * asking to stop waiting, not a failure, so it is swallowed here rather
 * than surfaced as a rejection every one of this function's many other
 * (signal-less) callers would then have to guard against.
 */
export async function sleep(
  seconds: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await sleepMs(seconds * 1000, undefined, { signal });
  } catch (e) {
    if (signal?.aborted) return;
    throw e;
  }
}

/**
 * Validated seconds for a test-only concurrency hook, 0 when the variable is
 * unset. Proving that two concurrent calls on the same key can never both
 * succeed needs a way to FORCE the overlap deterministically — two processes
 * merely launched close together race real scheduling jitter and, on a
 * fast/idle machine, may simply run one after the other without ever
 * contending, which asserts nothing about the mutex itself.
 *
 * These hooks are live in the shipped scripts, not stripped for production —
 * so the delay is validated and hard-capped rather than trusted verbatim. An
 * uncapped delay that exceeded `$DRIVE_PR_LOCK_STALE_MIN` (the stale-lock
 * window, default 10 minutes) would let ANOTHER driver observe the lock as
 * abandoned and break it out from under a process that is merely sleeping, not
 * stuck — reopening the exact lost-update race the mutex exists to prevent,
 * the moment this process resumes and writes without owning the replacement
 * lock. The cap is a fixed constant, not itself an env var: an override
 * channel for the cap would just move the same unbounded-input problem one
 * level out.
 *
 * Returns rather than sleeps, so a caller can validate BEFORE firing whatever
 * signal tells a waiting test it is about to sleep — a rejected delay must
 * never let that test believe this process is holding a lock when it is
 * actually about to exit without either.
 */
export function testDelaySeconds(envVar: string, label: string): number {
  const raw = process.env[envVar] ?? "";
  if (raw === "") return 0;
  const max = 5;
  const malformed =
    /[^0-9.]/.test(raw) || (raw.match(/\./g) ?? []).length > 1 || raw === ".";
  if (malformed) {
    fail(
      2,
      `${label}: $${envVar} must be a non-negative number (got '${raw}').`,
    );
  }
  const seconds = Number.parseFloat(raw);
  if (seconds > max) {
    fail(
      2,
      `${label}: $${envVar} (${raw}) exceeds the ${max}s test cap — well under any real stale-lock window on purpose; a longer delay risks another driver breaking this lock while this process merely sleeps.`,
    );
  }
  return seconds;
}

/**
 * Is this process's OWN stderr the null device? The delivery-aware orphan
 * warning must not claim its once-only marker for a warning written into the
 * void — the bash original tested `[ /dev/fd/2 -ef /dev/null ]`, comparing
 * device and inode so any spelling of the redirect is recognised. `fstat(2)`
 * against `/dev/null`'s stat is the same comparison.
 *
 * Anything unanswerable — no `/dev/null` (Windows), an unstattable fd —
 * reads as "deliverable": when "never duplicate" and "never lose" conflict,
 * this fails toward warning again, exactly as the original did.
 */
export function stderrIsDevNull(): boolean {
  try {
    const fd = fstatSync(2);
    const nul = statSync("/dev/null");
    return fd.dev === nul.dev && fd.ino === nul.ino;
  } catch {
    return false;
  }
}

/**
 * Quote a string so POSIX `sh`/`bash` reads it back as this one literal —
 * the `printf %q` of the suggested-command rendering in the orphan warning. A
 * worktree path CAN contain an apostrophe; the `'\''` idiom survives it.
 */
export function shellQuote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9_\-./:=+@%^]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** First 12 characters, the SHA-abbreviation used across the skill's output. */
export function short(sha: string): string {
  return sha.slice(0, 12);
}

/** Read all of stdin (the reply-body channel several scripts use). */
export async function readStdinAll(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}
