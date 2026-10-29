/**
 * Small CLI primitives shared by every drive-pr script: exit-code plumbing,
 * argv validation helpers, and the few pure utilities that would otherwise be
 * copy-pasted per script. Process spawning lives in `proc.ts`; durable-state
 * concerns live under `state/`.
 */

import { fstatSync, statSync } from "node:fs";

// The exit plumbing and the command-line boundary are the plugin's shared
// ones, so a failure thrown by shared code (`proc.ts`'s refusals) exits with
// its own code here too, and `JIG_LOG=debug` reports every failure's stack
// and causes the same way.
import { fail, isDigits } from "../../../../shared/cli.ts";

export {
  isDigits,
  sleep,
  shellQuote,
  readStdinAll,
  ExitError,
  fail,
  failFrom,
  runMain,
} from "../../../../shared/cli.ts";

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
 * A fixed pacing value (a poll, a heartbeat, a kill grace, a poll floor) that
 * the test suite may lower through `envVar`, in the caller's own unit. A test
 * pacing seam, not configuration: tests that exercise the paced path would
 * otherwise sleep through the production value. It only ever lowers: digits
 * only, clamped to [`floor`, `production`]; unset or unusable keeps
 * `production`.
 */
export function testPacing(
  envVar: string,
  production: number,
  floor: number,
): number {
  const raw = process.env[envVar] ?? "";
  if (!/^[0-9]+$/.test(raw)) return production;
  return Math.min(production, Math.max(floor, Number.parseInt(raw, 10)));
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
 * The whole number from 1 to `max` that `flag` was given, or exit 2 with
 * `usage` when `raw` is missing, not digits, or out of range.
 */
export function positiveIntArg(
  flag: string,
  raw: string | undefined,
  max: number,
  usage: readonly string[],
): number {
  if (raw === undefined || !isDigits(raw))
    fail(2, `${flag} takes a whole number`, ...usage);
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    fail(2, `${flag} must be between 1 and ${max}`, ...usage);
  return n;
}

/** First 12 characters, the SHA-abbreviation used across the skill's output. */
export function short(sha: string): string {
  return sha.slice(0, 12);
}
