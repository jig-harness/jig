#!/usr/bin/env bun
/**
 * The LAST step of the `pre-push` hook chain: re-read the mailbox `hold-push`
 * directive at the latest point this repository can reach before git
 * transfers objects.
 *
 * `guarded-push.ts` checks the hold before it calls `git push`, but that one
 * call runs the whole pre-push chain first — the heavy build+test phase can
 * take tens of minutes — so a `hold-push` sent DURING validation never
 * reached the push already underway. The boundary between "the hook passes"
 * and "git starts transferring" lives inside git; the only place outside it
 * that runs after every other gate is the hook chain itself, so the recheck
 * lives here, ordered after every other `pre-push` command (the ordering
 * contract, and the test that pins it, are documented at the `lefthook.yml`
 * entry).
 *
 * Opt-in by the environment, never by guessing: `guarded-push.ts` exports
 * `$DRIVE_PR_HOLD_RECHECK_PR` (and `$DRIVE_PR_MAILBOX_DIR`) to the `git push`
 * it spawns, plus `$DRIVE_PR_HOLD_RECHECK_ABORT_FILE`, which this script writes
 * only when it aborts the push for a hold. A push nobody wrapped — a
 * developer's own — leaves the PR variable unset. The documented hook starts
 * Bun for every push; this script then exits before reading the mailbox when
 * that variable is unset.
 *
 * Fail-closed like every other reader of the directive log: a hold, or a
 * directive log this cannot read, aborts the push (exit 17 — the hook's
 * non-zero status is what makes git abort). A malformed `$DRIVE_PR_HOLD_RECHECK_PR`
 * refuses too, an empty one included: the variable being set means a guarded push asked for this
 * check, so "cannot tell which PR" must not read as "no hold".
 *
 * Exit codes: 0 no hold (push proceeds); 17 a hold is active, or the state
 * could not be read; 2 the PR variable is set but not a PR number.
 */

import { writeFileSync } from "node:fs";
import { fail, isDigits, runMain } from "./lib/cli.ts";
import {
  holdAbortUnmarkedSentinel,
  PUSH_HELD_EXIT,
  readPushHoldUnderLock,
  resolveMailboxDir,
} from "./lib/state/mailbox.ts";

async function main(): Promise<number> {
  const raw = process.env.DRIVE_PR_HOLD_RECHECK_PR;
  // Unset: not a guarded push; return before reading the mailbox. SET but
  // empty is not "unset" — it falls through to the malformed refusal below.
  if (raw === undefined) return 0;
  if (!isDigits(raw)) {
    fail(
      2,
      `push-hold-recheck: $DRIVE_PR_HOLD_RECHECK_PR is '${raw}', not a PR number —`,
      "refusing to push when the hold state cannot be attributed to a PR.",
    );
  }
  // Canonical form, matching what `mailbox.ts send` wrote (leading zeros
  // stripped) — the fold compares PR strings for plain equality.
  const pr = BigInt(raw).toString();
  // A read that THROWS (mailbox dir unresolvable, lock not acquirable) is an
  // unknown hold state: fail closed through the same marked-abort path as a
  // live hold, so the wrapper reports the recoverable exit 17 rather than a
  // generic push failure.
  let held: { blocked: boolean; reason: string };
  try {
    held = await readPushHoldUnderLock(
      await resolveMailboxDir(),
      pr,
      "push-hold-recheck.ts (pre-push)",
    );
  } catch (e) {
    held = {
      blocked: true,
      reason: `hold-push state could not be read (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (held.blocked) {
    // Tell the wrapping `guarded-push.ts` THIS abort is why the push failed.
    // It cannot infer that from the mailbox afterwards: a failed gate or a
    // remote rejection followed by a hold sent later reads identically.
    const abortFile = process.env.DRIVE_PR_HOLD_RECHECK_ABORT_FILE;
    if (abortFile) {
      try {
        writeFileSync(abortFile, held.reason);
      } catch {
        // The abort itself (exit 17) still stops the push; the wrapper's
        // marker is lost, so say so in-band, where it reads git's relayed
        // hook output.
        const nonce = process.env.DRIVE_PR_HOLD_RECHECK_NONCE;
        if (nonce) console.error(holdAbortUnmarkedSentinel(nonce));
      }
    }
    fail(
      PUSH_HELD_EXIT,
      `push-hold-recheck: ${held.reason}.`,
      "The push was aborted before any objects were transferred. Clear it with:",
      `  bun <skill-dir>/scripts/mailbox.ts send ${pr} --kind directive --from <you> --command resume --target hold-push`,
      "then re-run the push.",
    );
  }
  return 0;
}

runMain("push-hold-recheck.ts", main);
