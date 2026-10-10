#!/usr/bin/env bun
/**
 * May this session still post to GitHub on this drive's behalf?
 *
 * The read-only fence in front of an IRREVERSIBLE external mutation
 *. an earlier change fenced every DRIVE-STATE mutation behind the session
 * lease, so a revoked pass can no longer overwrite another session's holds.
 * The one thing it did not cover is the act that cannot be taken back: posting
 * a comment. `reply-to-thread.ts` and `answer-summary-finding.ts` used to meet
 * the lease only AFTERWARDS, at the `drive-state.ts hold` that records what
 * they already posted — by which time the duplicate `**accepted**` reply is on
 * the thread and unwithdrawable.
 *
 * Usage: assert-post-allowed.ts [--pr N] [--what LABEL]
 *
 *   --pr N     the PR being posted to. Defaults to `$DRIVE_PR_TARGET` (set by
 *              drive.ts, and only there), and with neither the fence checks
 *              every lease THIS WORKING TREE holds. Deliberately never
 *              network-resolved: the fence sits in the hot path of every
 *              reply, and a `gh pr view` round-trip per thread would buy a PR
 *              number the actor-wide check does not need.
 *   --what     what is about to be posted, named in the refusal. Defaults to
 *              this script's own name.
 *
 * Exit 0   allowed — no drive state here, no lease, this session's own lease,
 *          or a foreign lease whose owner is gone or has stopped driving.
 * Exit 11  REFUSED — another live session in this tree holds the drive lease.
 * Exit 1   indeterminate — the fence could not read what it needs, which is
 *          also a refusal (`.claude/rules/document-scanning-gates.md` rule 1).
 * Exit 2   usage, or a `$DRIVE_PR_SESSION` that names a dead or malformed pid
 *          (`lease.ts`'s ladder refuses that outright — a lease taken under a
 *          dead pid excludes nobody, and the pass carrying it has outlived the
 *          driver that exported it).
 *
 * Callers treat ANY non-zero as "do not post". The codes are for humans and
 * for `drive-status.ts`-style consumers, not for a caller to branch on: the
 * distinction that matters at a call site is allowed vs not, and a caller that
 * enumerated the refusal codes would fail open on the next one added.
 *
 * `/resolve-review-comments` reaches this by SPAWNING it, and skips when this
 * whole skill is absent — it syncs standalone to repositories that have no
 * `/drive-pr`. That the fence is optional there, so post safety varies by
 * installation shape, is decided rather than incidental: see
 * `../references/post-fence.md`.
 *
 * A SEPARATE script rather than a `drive-state.ts` subcommand, because
 * `drive-state.ts` resolves its PR through `resolvePr` — a network call when
 * the PR is not explicit — and because it is the mutating surface: this is a
 * pure read, and the cross-skill caller in `/resolve-review-comments` should
 * not have to reach into a command list where every other entry writes.
 *
 * On Windows, invoke through the runtime (`bun assert-post-allowed.ts …`) — a
 * shebang only carries the POSIX direct-execution path.
 */

import { fail, isDigits, runMain } from "./lib/cli.ts";
import {
  assertRemoteMutationAllowed,
  assertTreeMutationAllowed,
  resolveFenceContext,
} from "./lib/state/lease.ts";

const LABEL = "assert-post-allowed.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let pr = "";
  let what = LABEL;
  const take = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) fail(2, `${LABEL}: ${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--pr":
        pr = take("--pr", i++);
        break;
      case "--what":
        what = take("--what", i++);
        break;
      default:
        fail(2, `usage: ${LABEL} [--pr N] [--what LABEL]`);
    }
  }
  if (pr === "") pr = process.env.DRIVE_PR_TARGET ?? "";
  // A malformed PR is refused rather than silently downgraded to the
  // actor-wide check. The two are different questions, and answering the
  // broader one under a caller who asked the narrower would report a refusal
  // about a drive they never named.
  if (pr !== "" && !isDigits(pr)) {
    fail(2, `${LABEL}: --pr must be a number (got '${pr}')`);
  }

  const ctx = await resolveFenceContext(what);
  // No git dir for drive state to live in, so no lease can exist here to have
  // been revoked. Absence of a lease is never itself a refusal — that is the
  // standalone `/resolve-review-comments` path, and it stays unchanged.
  if (ctx === null) return 0;
  // A CHECK only, not a held lock — same reasoning as the
  // TREE-WIDE half below, and for the identical structural reason: this
  // script's own job ends the instant it returns, and the POST it is
  // clearing the way for happens in the CALLING process
  // (`reply-to-thread.ts`), spawned afterward. There is no in-process
  // critical section here for a lock to span, so released immediately —
  // holding it past this process's own exit protects nothing.
  const remoteLock = await assertRemoteMutationAllowed(
    ctx,
    pr === "" ? null : pr,
    what,
  );
  if (remoteLock !== null) {
    remoteLock.release();
    remoteLock.dispose();
  }
  // The TREE-WIDE half, alongside the per-PR one above: this
  // script only ever checked whether the CALLER'S OWN per-PR lease had been
  // taken over, never whether this working TREE had — so an orphaned pass
  // for PR A, still carrying a per-PR lease that nothing has revoked, kept
  // passing this fence even after a replacement session took the tree for
  // PR B (docomply-review round 10, a reference-implementation pull request: guarded-push.ts was wired to
  // the tree fence, this script was not, and it guards the identical class
  // of irreversible act — a POST).
  //
  // A CHECK only, not a held lock: this script's own job ends the instant it
  // returns, and the POST it is clearing the way for happens in the CALLING
  // process (`reply-to-thread.ts`), spawned afterward — there is no
  // in-process critical section here for a lock to span, the same residual
  // `assertRemoteMutationAllowed`'s own POST-adjacent callers already carry
  // (`lease.ts`'s header states it rather than implies it). Released
  // immediately: holding it past this process's own exit protects nothing.
  const treeLock = await assertTreeMutationAllowed(
    ctx,
    pr === "" ? null : pr,
    what,
  );
  treeLock.release();
  treeLock.dispose();
  return 0;
}

runMain(LABEL, main);
