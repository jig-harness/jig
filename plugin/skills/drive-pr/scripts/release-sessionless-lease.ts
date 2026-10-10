#!/usr/bin/env bun
/**
 * Release this working tree's TIER-3 PRESENCE RECORDS for one PR, on the
 * COMPLETION of the sessionless resolver that took them.
 *
 * The counterpart to `assert-post-allowed.ts`: a standalone CLI living in
 * `/drive-pr` and existing for one cross-skill caller, `/resolve-review-comments`'s
 * `converge.ts`, which SPAWNS it rather than importing `lib/state/lease.ts` —
 * that skill syncs standalone into repositories with no `/drive-pr` at all, and
 * a spawn's absence is a filesystem question where an import's would be a broken
 * install. The decision record for that boundary is
 * `../references/post-fence.md`.
 *
 * Usage: release-sessionless-lease.ts --pr N [--what LABEL]
 *
 *   --pr N     REQUIRED. Both halves of the release are scoped to it: the per-PR
 *              record is named by it, and the TREE record is released only while
 *              it still names this same PR. Never network-resolved and never
 *              defaulted from `$DRIVE_PR_TARGET` — that variable is exported by
 *              `drive.ts` alone, and a `drive.ts` drive is never sessionless (it
 *              always exports `$DRIVE_PR_SESSION`, ladder tier 1), so a default
 *              from it could only ever name a PR this script has nothing to do.
 *   --what     who is releasing, named in the report. Defaults to this script's
 *              own name.
 *
 * WHAT IT REMOVES, and nothing else:
 *
 *   - `leasePathFor(stateDir, pr, actor)` — only while it reads as
 *     `holder: 'worktree'`. A `holder: 'session'` lease is never touched: it
 *     already self-releases when its pid dies, so there is no asymmetry there to
 *     close, and touching it would put this cleanup path inside the pid-recycling
 *     reasoning `lease.ts`'s header carries for session ownership.
 *   - `treeLeasePathFor(stateDir, actor)` — only while it reads as
 *     `holder: 'worktree'` AND its `pr` canonically equals `--pr`. That tree
 *     record is one file per WORKING TREE naming whichever PR the tree is now
 *     driving, so releasing it unconditionally would strip a DIFFERENT, still-live
 *     sessionless drive's protection.
 *
 * SAFE TO CALL SPECULATIVELY. Nothing to release, a record held by a session, a
 * tree record that has moved on to another PR, no state directory, no git
 * repository — every one of those is a silent exit 0. That is not a fence
 * failing open: this authorises no act at all, so the failure direction is
 * simply "the record expires by staleness", which is exactly the older
 * behaviour. The inverse of `assert-post-allowed.ts`, which guards an
 * irreversible POST and must therefore refuse on any unreadable input
 * (`.claude/rules/document-scanning-gates.md` rule 1).
 *
 * Exit 0   released something, or there was nothing this may release.
 * Exit 1   the release could not be completed — lock contention, an unreadable
 *          or unwritable state directory. Nothing was released; the record clears
 *          by staleness as it did before this script existed.
 * Exit 2   usage.
 *
 * Callers treat this as CLEANUP, never as a gate: `converge.ts` swallows every
 * outcome and keeps its own exit code, because a lease that failed to release is
 * not a reason to misreport whether a PR converged.
 *
 * On Windows, invoke through the runtime (`bun release-sessionless-lease.ts …`) —
 * a shebang only carries the POSIX direct-execution path.
 */

import { existsSync } from "node:fs";
import { ExitError, fail, isDigits, runMain } from "./lib/cli.ts";
import {
  leaseHolderLabel,
  releaseSessionlessLease,
} from "./lib/state/lease.ts";
import { openStore, resolveStateDir } from "./lib/state/store.ts";

const LABEL = "release-sessionless-lease.ts";

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
        fail(2, `usage: ${LABEL} --pr N [--what LABEL]`);
    }
  }
  // REQUIRED rather than defaulted, and a malformed one is a usage error rather
  // than a silent no-op: both halves of the release are scoped to this number,
  // and a caller who fat-fingered it would otherwise be told its record was
  // released when a different (or no) record was looked at.
  if (pr === "") fail(2, `usage: ${LABEL} --pr N [--what LABEL]`);
  if (!isDigits(pr)) fail(2, `${LABEL}: --pr must be a number (got '${pr}')`);

  // No git dir for drive state to live in means no lease can exist here to
  // release — the standalone `/resolve-review-comments` case, and the same
  // ruling `assert-post-allowed.ts` makes on its own `resolveFenceContext`
  // returning `null`. `resolveStateDir` states that as a usage failure because
  // its usual callers cannot work without a store; this one has nothing to do
  // and says so.
  //
  // `resolveStateDir` prints its own "no state dir" line to stderr BEFORE
  // throwing, so this swallow is silent in the exit code but not in the output
  // a caller inheriting stderr sees. Left as is deliberately: quieting it means
  // re-deriving the store's own resolution here, and a second copy of "where
  // does drive state live" is a worse trade than one stray diagnostic on a path
  // that only occurs outside a git repository.
  let stateDir: string;
  try {
    stateDir = await resolveStateDir();
  } catch (e) {
    if (e instanceof ExitError) return 0;
    throw e;
  }
  // Checked BEFORE `openStore`, which would `mkdirSync` it: a cleanup that
  // CREATES the directory it found nothing in is a side effect nobody asked
  // for. Narrow, and worth saying so rather than overclaiming — the ordinary
  // resolution is the git COMMON DIR, which exists in every repository, so
  // this only ever bites under a `$DRIVE_PR_STATE_DIR` override naming a path
  // that is not there (a caller pointing at a state dir that was reaped, and
  // the test that pins this).
  if (!existsSync(stateDir)) return 0;

  const store = await openStore(pr);
  // Under the PR's STATE MUTEX, exactly as `drive-state.ts`'s `clear-lease`
  // takes it around `clearLease` — see that command's own comment. The
  // admission fence runs inside a locked section and is followed by that
  // section's write; a removal landing between the two would make an
  // already-admitted command refuse a mutation nothing was in conflict with.
  // Holding this mutex means a release lands only BETWEEN locked sections.
  const gone = await store.locked(() =>
    releaseSessionlessLease(store.stateDir, pr),
  );

  // Reported per half, mirroring `clear-lease`: the two are released
  // independently, and a summary naming only the per-PR one would hide the tree
  // record's removal on the calls where there is no per-PR record at all.
  if (gone.lease === null && gone.treeLease === null) return 0;
  if (gone.lease !== null) {
    console.error(
      `${LABEL}: released PR #${pr}'s per-PR tier-3 lease (${leaseHolderLabel(gone.lease)}, last seen ${gone.lease.lastSeen}) on behalf of ${what}.`,
    );
  }
  if (gone.treeLease !== null) {
    console.error(
      `${LABEL}: released this working tree's TREE-WIDE tier-3 lease (${leaseHolderLabel(gone.treeLease)}, was on PR #${gone.treeLease.pr}, last seen ${gone.treeLease.lastSeen}) on behalf of ${what}.`,
    );
  }
  return 0;
}

runMain(LABEL, main);
