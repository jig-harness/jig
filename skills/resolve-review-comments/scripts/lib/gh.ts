/**
 * The bounded `gh` for this skill's TypeScript scripts — its chokepoint, the
 * counterpart to drive-pr's `lib/proc.ts`.
 *
 * Every outbound `gh` call must carry a deadline. `gh` has no timeout of its
 * own, and no caller can supply one from a poll loop: a deadline between calls
 * is never consulted during one, so a connection that is accepted and never
 * completes parks the caller indefinitely — mode 13 in drive-pr's
 * references/terminal-states.md. These scripts are spawned by the drive loop
 * (drive-pr SKILL.md §§ 2 and 6), so an unbounded call here hangs an
 * unattended driver exactly as one in drive-pr itself would (docomply-review,
 * a reference-implementation pull request round 1).
 *
 * Built on the sibling `lib/proc.ts`'s `run()` rather than `spawnSync`
 * (TASK). The straight-line callers here used to justify a separate
 * synchronous implementation — `spawnSync`'s own `timeout` was the deadline,
 * and a killed child surfaced as `status === null` with a `signal`. But while
 * the parent is blocked in that syscall it cannot run a JS signal handler, and
 * `spawnSync`'s child is not detached — so a SIGTERM delivered to the
 * script's pid alone killed the parent at kernel level mid-syscall and
 * orphaned `gh`, which ran a mutation to completion after the operator
 * believed it was cancelled. `run()` already solves exactly this for the
 * skill's polling scripts: a deadlined child is detached into its own process
 * group, and `lib/proc.ts`'s module-load signal handler forwards a
 * cancellation into that group. Routing through it closes the gap rather than
 * reimplementing it. The "SEPARATE implementation" boundary this header used
 * to document was about not importing *drive-pr's* `proc.ts` across a skill
 * boundary — this skill has carried its own `lib/proc.ts` in the same
 * directory since the TypeScript port, so that duplication is no longer
 * buying the isolation it was written for.
 */

import { fail } from "./cli.ts";
import { cachedRepoView } from "./gh-conditional.ts";
import { ghCallTimeoutSeconds, MAX_BUFFER_BYTES, run } from "./proc.ts";

/**
 * Run `gh` with the deadline and return its stdout, throwing an `ExitError`
 * on any failure — `runMain` (lib/cli.ts) converts that into the process exit
 * code. `label` names the calling script in the diagnostics, the way each
 * script's own inline helper did.
 *
 * `deadlineFactor` multiplies the per-call deadline for a `--paginate` call.
 * GH_CALL_TIMEOUT bounds ONE request, but `gh --paginate` makes N of them
 * inside a single process, so charging the whole list of pages against a
 * single request's budget would kill a legitimately long thread list rather
 * than a hang. The factor is the number of pages such a call is allowed, not a
 * fudge: `reviewThreads(first:100)` means four pages is four hundred review
 * threads, well past anything this repository has produced.
 *
 * `run()` bounds captured stdout+stderr at `MAX_BUFFER_BYTES` (its own
 * default, unchanged from `spawnSync`'s) rather than exposing a per-call
 * `maxBuffer` here — a runaway or pathologically large `gh` response is
 * killed the same way a hung one is, on `bufferExceeded` below.
 */
export async function ghOrExit(
  label: string,
  args: string[],
  opts: { deadlineFactor?: number } = {},
): Promise<string> {
  const factor = opts.deadlineFactor ?? 1;
  const baseSeconds = ghCallTimeoutSeconds();
  const timeoutSec = baseSeconds * factor;
  // `ghCallTimeoutSeconds()` already refuses a GH_CALL_TIMEOUT whose OWN
  // millisecond conversion would overflow `setTimeout`'s 32-bit delay and
  // fire immediately (the inverted-deadline failure `readTimeoutEnv` guards
  // against). The `--paginate` multiplication happens after that check, so an
  // otherwise-valid GH_CALL_TIMEOUT (single-digit days) times a deadlineFactor
  // of 4 can still land back in the overflow range — the same inversion,
  // reached through the one path the base check cannot see.
  if (timeoutSec * 1000 > 2_147_483_647) {
    fail(
      1,
      `${label}: GH_CALL_TIMEOUT (${baseSeconds}s) × deadlineFactor (${factor}) overflows the deadline timer — refusing`,
    );
  }
  const r = await run(["gh", ...args], { timeoutSec });
  // A killed child's partial stdout is NOT an answer — returning it would
  // hand the caller a truncated document to parse as if it were complete.
  if (r.timedOut) {
    fail(
      1,
      `${label}: gh ${args[0] ?? ""} killed after ${timeoutSec * 1000}ms`,
    );
  }
  if (r.bufferExceeded) {
    fail(
      1,
      `${label}: gh ${args[0] ?? ""} output exceeded ${MAX_BUFFER_BYTES / (1024 * 1024)}MiB — killed`,
    );
  }
  if (r.code !== 0) {
    fail(r.code, ...(r.stderr ? [r.stderr] : []));
  }
  return r.stdout;
}

/**
 * `gh repo view <args>` with `ghOrExit`'s failure discipline, answered from the
 * cross-process cache when a previous call for this repository succeeded
 * (`lib/gh-conditional.ts`, TASK). The repository's owner/name never
 * changes for a clone, but `gh repo view` is a GraphQL call — one point per
 * script invocation, which a drive multiplies by every script it spawns.
 */
export async function repoViewOrExit(
  label: string,
  args: string[],
): Promise<string> {
  const r = await cachedRepoView(args);
  if (r.timedOut) {
    fail(
      1,
      `${label}: gh repo view killed after ${ghCallTimeoutSeconds() * 1000}ms`,
    );
  }
  if (r.code !== 0) {
    fail(r.code, ...(r.stderr ? [r.stderr] : []));
  }
  return r.stdout;
}
