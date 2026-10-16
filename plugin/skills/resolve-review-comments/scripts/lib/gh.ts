/**
 * The bounded `gh` for this skill's TypeScript scripts — its chokepoint, built
 * on the plugin's shared `proc.ts`.
 *
 * Every outbound `gh` call must carry a deadline. `gh` has no timeout of its
 * own, and no caller can supply one from a poll loop: a deadline between calls
 * is never consulted during one, so a connection that is accepted and never
 * completes parks the caller indefinitely — mode 13 in drive-pr's
 * references/terminal-states.md. These scripts are spawned by the drive loop
 * (drive-pr SKILL.md §§ 2 and 6), so an unbounded call here hangs an
 * unattended driver exactly as one in drive-pr itself would.
 *
 * Built on `shared/proc.ts`'s `run()` rather than `spawnSync`. While the
 * parent is blocked in `spawnSync` it cannot run a JS signal handler, and
 * `spawnSync`'s child is not detached — so a SIGTERM delivered to the
 * script's pid alone kills the parent at kernel level mid-syscall and orphans
 * `gh`, which runs a mutation to completion after the operator believes it
 * was cancelled. `run()` detaches a deadlined child into its own process
 * group, and `proc.ts`'s module-load signal handler forwards a cancellation
 * into that group.
 */

import { fail, failFrom } from "../../../../shared/cli.ts";
import { cachedRepoView } from "../../../../shared/gh-conditional.ts";
import {
  ChildFailure,
  ghCallTimeoutSeconds,
  MAX_BUFFER_BYTES,
  type RunResult,
  run,
} from "../../../../shared/proc.ts";

/**
 * Exit 1 for a `gh` killed at its deadline or for its output. A killed child
 * printed no exit status of its own, so the last of its error output is the
 * only explanation there is: shown with the refusal, not only under
 * `JIG_LOG=debug`.
 */
function failKilled(
  label: string,
  argv: string[],
  r: RunResult,
  what: string,
): never {
  const tail = r.stderrTail.trimEnd();
  failFrom(
    new ChildFailure(argv, r),
    1,
    `${label}: ${what}`,
    ...(tail === "" ? [] : [`${label}: the end of gh's error output:`, tail]),
  );
}

/** Exit with `gh`'s own status, after its error output. */
function failExited(argv: string[], r: RunResult): never {
  failFrom(new ChildFailure(argv, r), r.code, ...(r.stderr ? [r.stderr] : []));
}

/**
 * Run `gh` with the deadline and return its stdout, throwing an `ExitError`
 * on any failure — `runMain` (shared/cli.ts) converts that into the process exit
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
  const argv = ["gh", ...args];
  const r = await run(argv, { timeoutSec });
  // A killed child's partial stdout is NOT an answer — returning it would
  // hand the caller a truncated document to parse as if it were complete.
  if (r.timedOut)
    failKilled(
      label,
      argv,
      r,
      `gh ${args[0] ?? ""} killed after ${timeoutSec * 1000}ms`,
    );
  if (r.bufferExceeded)
    failKilled(
      label,
      argv,
      r,
      `gh ${args[0] ?? ""} output exceeded ${MAX_BUFFER_BYTES / (1024 * 1024)}MiB — killed`,
    );
  if (r.code !== 0) failExited(argv, r);
  return r.stdout;
}

/**
 * `gh repo view <args>` with `ghOrExit`'s failure discipline, answered from the
 * cross-process cache when a previous call for this repository succeeded
 * (`shared/gh-conditional.ts`). The repository's owner/name never
 * changes for a clone, but `gh repo view` is a GraphQL call — one point per
 * script invocation, which a drive multiplies by every script it spawns.
 */
export async function repoViewOrExit(
  label: string,
  args: string[],
): Promise<string> {
  const r = await cachedRepoView(args);
  const argv = ["gh", "repo", "view"];
  if (r.timedOut)
    failKilled(
      label,
      argv,
      r,
      `gh repo view killed after ${ghCallTimeoutSeconds() * 1000}ms`,
    );
  if (r.code !== 0) failExited(argv, r);
  return r.stdout;
}
