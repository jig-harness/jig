#!/usr/bin/env bun
import { definedFields } from "../../../shared/defined-fields.ts";
/**
 * Decide, mechanically, which state a PR-review drive is in — and in particular
 * refuse to say "converged" on any evidence weaker than "the finding-posting
 * reviewer completed a review of THIS exact SHA and had nothing left to say".
 *
 * This is the SHA-verified successor to await-round.ts's exit-3. That script
 * decides convergence from "reviewer-shaped checks are settled AND the
 * unresolved thread count is zero", and every one of the following has
 * produced a false exit 3 on this repository:
 *
 *   1. Summary-only findings create no thread at all — the reviewer emits them
 *      in its sticky comment (and its `ai-review-backlog` blob) with no
 *      diff-anchorable line. Thread count is 0 while real findings are live.
 *   2. A draft-parked or rate-limited CodeRabbit posts `success` for a review
 *      that never ran. On this repo that is the STANDING state, not an edge
 *      case.
 *   3. PR-head replication lag: seconds after a push `gh pr view --json
 *      headRefOid` still returns the PREVIOUS SHA, where everything was
 *      settled and resolved.
 *   4. A satisfied non-posting reviewer masks the posting reviewer's
 *      not-yet-created check-run. `gh pr checks` can omit the posting
 *      reviewer's check entirely while listing CodeRabbit as settled.
 *
 * The fix in every one of those cases is the same shape: never infer a
 * reviewer's verdict from the absence of contrary evidence. Ask the check-runs
 * API for the ONE app that posts findings, for the ONE SHA that is the PR
 * head, and cross-check the reviewer's own recorded reviewed-SHA marker.
 * The decision itself lives in `lib/status/evaluate.ts`; the witnesses it
 * weighs live in `lib/status/evidence.ts`. This entry owns the CLI, the wait
 * loop, and the report.
 *
 * Usage: drive-status.ts [PR] [flags]
 *
 *   --json               emit the structured report on stdout (always machine
 *                        readable; without it only the state name is printed)
 *   --once               evaluate once; never sleep. A not-yet-settled state
 *                        returns 4 rather than waiting.
 *   --timeout SECONDS    give up waiting (default 1800). Exits 4.
 *   --interval SECONDS   poll spacing while waiting (default 30, min 5).
 *   --bots-only          count only bot-authored threads, matching the set a
 *                        --bots-only pass actually resolves.
 *   --head SHA           the local head to compare the API head against.
 *                        Defaults to `git rev-parse HEAD`; pass explicitly
 *                        when driving from outside the PR's worktree.
 *   --no-head-sync       skip the replication-lag guard entirely (only correct
 *                        when you know the local tree is not the PR branch).
 *   --inherited-head SHA let the guard pass a local HEAD that is exactly SHA
 *                        and descends from the API head: the commits a pass
 *                        killed at its deadline left unpushed (the driver's
 *                        restart notice names it). Any other mismatch lags.
 *   --no-count           do not count this evaluation as a worked round. Also
 *                        suppresses the replied-thread reconciliation sweep
 *                        below — a mid-round re-read is not a pass entry.
 *   --no-reconcile       skip the reconciliation sweep for this invocation.
 *
 *                        BOTH of the above suppress the sweep, and neither
 *                        VOUCHES for one, so an invocation carrying either
 *                        cannot certify a verdict that ends the drive
 *                        (`UNRECONCILED_STOPPERS`): those report INDETERMINATE
 *                        under it, naming the flag. Every other verdict is
 *                        unaffected, which is why `announce-merge-ready.ts`'s
 *                        own `--no-count` re-read (it only ever acts on
 *                        CONVERGED) is untouched.
 *   --bump-attempt       on ROUND_READY (case 0 below), also record a pass
 *                        attempt on this head (drive-state.ts bump-attempt)
 *                        BEFORE computing `reflectDue` — the single pass-start
 *                        entry point for the interactive path (SKILL.md § 1).
 *                        Folds what used to be two more commands, run only
 *                        after this one, into this same call: without it,
 *                        `reflectDue` was read off counters as they stood
 *                        before the pass they describe was recorded, off by
 *                        exactly one pass. `drive.ts` does not pass this — it
 *                        bumps the attempt itself, after this script returns,
 *                        and derives its own `$DRIVE_PR_REFLECT_DUE` from the
 *                        post-bump state directly. A pass `drive.ts` SPAWNS
 *                        still runs this script with the flag (SKILL.md § 1
 *                        always passes it), but the bump itself is skipped
 *                        there — `$DRIVE_PR_TARGET`, present only inside a
 *                        drive.ts-spawned pass, is the signal that the driver's
 *                        own bump already covered this round.
 *
 * Every COUNTING invocation — i.e. a pass entry — first runs
 * `reconcile-replied-threads.ts` on this PR. That script answers a question
 * this gate deliberately refuses to ("was an outcome reply already posted on a
 * thread that never got resolved or held?"), and it needs nothing this gate
 * withholds. Wiring it in here is what bounds the leak: every state below
 * except ROUND_READY ends the round without a pass running, so a duty that only
 * ever executed inside a pass could never fire while the gate was stuck on one
 * of them — which is precisely when it is needed (measured: a CONFLICTING PR
 * gets zero `pull_request` CI, the posting reviewer's check-run never appears,
 * and AWAITING_REVIEWER below returns before this evaluation even enumerates
 * threads). The sweep runs BEFORE the evaluation, once per invocation, behind a
 * liveness read — a finished PR must not be mutated by a round it already
 * stopped.
 *
 * Its failure never wedges a round this gate could otherwise judge, but it is
 * not simply discarded either, and the line between those is which verdict
 * follows: a verdict that ASSERTS THE DRIVE IS OVER is withheld until a sweep
 * has run and succeeded, degrading to INDETERMINATE (which `drive.ts`
 * propagates as a stop-and-look) instead, because after one of those no later
 * pass is promised and an already-answered thread would stay unresolved with
 * nothing left to retry it — the same leak, one level up.
 *
 * `UNRECONCILED_STOPPERS` below is that set FOR MOST CODES, and is the single
 * place their membership is enumerated. Restating the members here would be a
 * second copy to keep in step, and was already stale once (it still named the
 * pre-exit-7 set, plus a count derived from it). The criterion that produces
 * the set, and the reason each excluded code is excluded, live with the guard
 * at the bottom of the poll loop. CONVERGED (3) is withheld the same way but is
 * NOT a member of that set — it has its own, narrower condition beside the
 * guard (`convergedUnswept`), for a reason documented there and in an earlier
 * change.
 *

 * Exit codes — the driver contract. Every one of them is a distinct decision;
 * none of them is a variant of "done" except 3.
 *
 * Each row is tagged with which of four kinds of identifier it carries — the
 * distinction `<skill-dir>/scripts/lib/status/terminal-states.ts`
 * (the code-bound single source of truth for the pairing below) formalizes,
 * and `__tests__/terminal-states-consistency.ts` (repo root) checks this
 * table against: [state] a real `state` value this script's `--json` report
 * can carry; [class label] a name for a FAMILY of states sharing one exit
 * code, never itself emitted; [retired] a withdrawn code, deliberately never
 * re-emitted; [drive.ts only] an exit `drive.ts` itself returns directly,
 * outside this script and its `--json` report entirely.
 *
 *   0  ROUND_READY      [state] work exists: unresolved threads and/or
 *                       unaddressed summary-only findings. On a MERGEABLE
 *                       head the reviewer is also known to have reviewed it
 *                       (the gates ran); on a CONFLICTING one those gates are
 *                       skipped, so the findings may predate this head — the
 *                       report says which, and the work is handed out either
 *                       way
 *   3  CONVERGED        [state] SHA-verified: posting reviewer completed on
 *                       this head, its recorded reviewed SHA equals this
 *                       head, zero unresolved threads, zero unaddressed
 *                       summary findings. `drive.ts` remaps this SAME state
 *                       to exit `0` at its own call site — see SKILL.md §
 *                       Terminal states
 *   4  NOT_SETTLED      [class label, never emitted] the round is not ready
 *                       to judge yet — the real `state` values sharing this
 *                       exit code are HEAD_LAG, AWAITING_REVIEWER,
 *                       STALE_REVIEW, HEAD_MOVED and MERGEABILITY_UNKNOWN
 *                       (head lag, reviewer still running, stale
 *                       reviewed-SHA, mergeability still recomputing) — with
 *                       --once this is returned immediately; otherwise after
 *                       --timeout
 *   5  PR_NOT_OPEN      [state] merged or closed — stop, and do NOT push
 *  10  RETIRED          [retired, never emitted] was PR_IS_DRAFT, on the
 *                       premise that no reviewer arm looks at a draft. Measured
 *                       false 2026-08-13: the posting reviewer reviews drafts,
 *                       so a draft is driven like any other PR and
 *                       `mark-ready.ts` marks it Ready at the round
 *                       pull_requests.mark_ready declares — see
 *                       lib/status/evaluate.ts's header. Not recycled: an old
 *                       log's `10` should mean nothing, not something new
 *   7  REVIEWER_FAILED  [state] the posting reviewer's check-run did not
 *                       pass, so it may never have reported; a zero thread
 *                       count means nothing
 *   8  HITL_PARKED      [state] everything still open awaits a human
 *                       decision
 *   9  PR_CONFLICTING   [state] the PR conflicts with its base AND has
 *                       nothing left to work. A conflict with live findings
 *                       is ROUND_READY instead — the reviewer is a poller,
 *                       not a `pull_request` workflow, so it CAN publish
 *                       findings on a conflicting head. Only the no-work case
 *                       is terminal
 *  11  SESSION_LEASE_HELD  [state, set outside evaluate]
 *                       another LIVE session in this working tree holds the
 *                       drive lease for this PR. Raised by whichever
 *                       leased bump this gate performs first — `bump-round`
 *                       ordinarily, or `bump-attempt` when `--no-count` skips
 *                       that one — and
 *                       propagated rather than flattened: the refusal names
 *                       the holder's pid, the platform's liveness check and `clear-lease` on stderr,
 *                       which is the whole reason the lease records a holder.
 *                       Same code and meaning as `drive-state.ts`'s own 11.
 *                       `drive.ts` ALSO returns 11 directly, before this
 *                       script ever runs, for its own single-instance lock —
 *                       a distinct [drive.ts only] cause sharing this code by
 *                       design, never this script's `SESSION_LEASE_HELD`
 *  13  DRIVE_HELD_BY_OTHER_WORKTREE  [state]
 *                       another LIVE working tree is driving this PR. The
 *                       cross-tree twin of 11, raised at the same leased bump
 *                       and propagated for the same reason — and a DISTINCT
 *                       code because the remedy differs: 11 points at a session
 *                       the reader can see and `clear-lease` where they stand,
 *                       while 13 names a tree they are not in and whose driver
 *                       is very likely the one that should finish. Same code
 *                       and meaning as `drive-state.ts`'s 13
 *   1  INDETERMINATE    [state] the state could not be read — never reported
 *                       as settled
 *   2  UNSUPPORTED_CLI  [state] an unmet prerequisite: a `gh` that cannot
 *                       report mergeability. Reported through the JSON
 *                       contract like every other state — only argument
 *                       errors, which happen before there is a PR to
 *                       describe, exit without a report
 *
 *  12  —  [drive.ts only, no report] converged, but the worktree is not
 *         clean. No named `state` — this exit never reaches `--json` at all
 *  14  —  [drive.ts only, no report] the loop stalled — see
 *         `references/terminal-states.md` row 14
 *  15  PASS_DEADLINE    [drive.ts only, no report] `$DRIVE_PR_PASS_TIMEOUT`
 *                       expired mid-round. Named (`PASS_DEADLINE_EXIT`), but
 *                       never reaches this script's `--json` report — see
 *                       `references/terminal-states.md` row 15
 *  16  QUOTA_PARKED     [drive.ts only, no report] the pass died on a
 *                       subscription usage wall. Named (`QUOTA_PARKED_EXIT`),
 *                       never reaches this script's `--json` report — see
 *                       `references/terminal-states.md` row 16
 *  18  MAILBOX_STOPPED [drive.ts only, no report] a stop directive ended the
 *                       drive at a safe round boundary
 *  19  MAILBOX_PAUSE_TIMEOUT [drive.ts only, no report] a pause remained
 *                       active beyond the driver's bounded wait
 *  20  TAKEN_OVER       [drive.ts only, no report] another clone's newer
 *                       takeover claim is on the pull request
 *   6  —  [drive.ts only, no report] hit `--max-rounds` without converging
 *
 * The JSON report carries `state` (the name above) plus the evidence behind
 * it, so a caller never has to parse prose — see references/terminal-states.md.
 * The canonical (exit, state) pairing itself is code, not this comment:
 * `<skill-dir>/scripts/lib/status/terminal-states.ts`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BaseDrift,
  driftLine,
  fetchTimeoutSeconds,
  probeBaseDrift,
  verifyCheckoutIsPrHead,
  verifyOriginIsPrRepo,
} from "./lib/base-drift.ts";
import { fail, isDigits, runMain, sleep, testPacing } from "./lib/cli.ts";
import {
  fleetHealthLine,
  readFleetHealthAdvisory,
} from "./lib/fleet-health-advisory.ts";
import { cachedRepoView } from "./lib/gh-conditional.ts";
import { readPrState } from "./lib/pr-state.ts";
import {
  ghCall,
  git,
  gitCallTimeoutSeconds,
  // The ONE scrubbed-env derivation (lib/proc.ts), not a fourth private copy:
  // three had drifted, and only this file's carried `GIT_NAMESPACE` and the
  // Windows case-folding that two measured leaks had already been fixed for.
  gitIdentityEnv,
  readTimeoutEnv,
  run,
  tsArgv,
} from "./lib/proc.ts";
import { reviewerApp } from "./lib/overlay.ts";
// The code itself, not hand-written `11`/`13` literals repeated here: this
// script's exit means what `drive-state.ts`'s means, and two independent
// numbers are exactly how that stops being true.
import {
  DRIVE_HELD_ELSEWHERE_EXIT,
  SESSION_LEASE_HELD_EXIT,
} from "./lib/state/lease.ts";
import {
  type EscalationState,
  type ReflectCounters,
  reflectDepthPastLast,
  structuralEscalationArmed,
  structuralEscalationInvariant,
} from "./lib/state/schema.ts";
import { reflectionSwitch } from "../../reflect/scripts/lib/settings.ts";
import {
  emptyReport,
  evaluate,
  type StatusReport,
} from "./lib/status/evaluate.ts";
import { isFullSha } from "./lib/status/inherited-head.ts";
// `report.state` and the emitted/returned exit code for these two
// out-of-band states are derived from ONE lookup — see
// `outOfBand()`'s own doc comment for the pairing-drift bug this closes.
import { outOfBand } from "./lib/status/terminal-states.ts";
import {
  WaitingEvaluationCache,
  waitingChecksMaxAgeMs,
} from "./lib/status/waiting-cache.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The `--interval` floor. Takes a test pacing seam (`testPacing`): a probe
 * that must poll several times would otherwise spend 5s per poll asleep.
 */
const MIN_INTERVAL = testPacing("DRIVE_PR_STATUS_MIN_INTERVAL", 5, 1);
const MAX_QUERY_ERRORS = 3;

/**
 * `realpathSync`, bounded — a stalled FUSE/NFS mount can block this SYNCHRONOUS
 * call indefinitely in THIS process, and `GIT_CALL_TIMEOUT` bounding the
 * local-HEAD measurement's `git()` subprocess calls (further down this file)
 * does nothing for it. Runs as a separate bounded subprocess — same convention
 * `unconcludedGitOpMarker`'s marker probe in `lib/proc.ts` uses — so `run()`'s
 * existing timeout-and-kill can bound it exactly like every other call here,
 * without a shell of any kind.
 */
const REALPATH_PROBE_SCRIPT = `
const { realpathSync } = require('node:fs');
const [p] = process.argv.slice(1);
try {
  process.stdout.write(realpathSync(p));
} catch {}
process.exit(0);
`;

async function boundedRealpath(
  p: string,
  timeoutSec: number,
): Promise<string | null> {
  // `realpathSync('')` resolves to `process.cwd()` instead of throwing (a
  // Node/Bun quirk, verified empirically) — every caller here treats an empty
  // string as "nothing to resolve", never as "resolve my cwd", so this must
  // refuse before ever reaching the probe subprocess.
  if (p === "") return null;
  const probe = await run([process.execPath, "-e", REALPATH_PROBE_SCRIPT, p], {
    stderr: "ignore",
    ...definedFields({ timeoutSec }),
  });
  if (probe.code !== 0) return null;
  const resolved = probe.stdout.trim();
  return resolved === "" ? null : resolved;
}

/**
 * Exit codes this gate refuses to report while the replied-thread
 * reconciliation sweep is outstanding. See the guard at the bottom of the poll
 * loop for the criterion that produces this set, and for why each code NOT in
 * it is absent.
 */
const UNRECONCILED_STOPPERS = new Set([2, 7, 8, 9, 10]);

async function main(): Promise<number> {
  let pr = "";
  let json = false;
  let once = false;
  let timeout = 1800;
  let interval = 30;
  let botsOnly = false;
  let localHead = "";
  let headSync = true;
  let inheritedHead = "";
  let noCount = false;
  let noReconcile = false;
  let bumpAttempt = false;

  const argv = process.argv.slice(2);
  const take = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) fail(2, `${flag} requires a value`);
    return value;
  };
  let timeoutRaw = "1800";
  let intervalRaw = "30";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--json":
        json = true;
        break;
      case "--once":
        once = true;
        break;
      case "--bots-only":
        botsOnly = true;
        break;
      case "--no-head-sync":
        headSync = false;
        break;
      case "--no-count":
        noCount = true;
        break;
      case "--no-reconcile":
        noReconcile = true;
        break;
      case "--bump-attempt":
        bumpAttempt = true;
        break;
      case "--timeout":
        timeoutRaw = take(a, i++);
        break;
      case "--interval":
        intervalRaw = take(a, i++);
        break;
      case "--head":
        localHead = take(a, i++);
        break;
      case "--inherited-head":
        inheritedHead = take(a, i++);
        if (!isFullSha(inheritedHead)) fail(2, `${a} takes a full commit SHA`);
        break;
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }

  if (!isDigits(timeoutRaw) || !isDigits(intervalRaw))
    fail(2, "--timeout and --interval take whole seconds");
  timeout = Number.parseInt(timeoutRaw, 10);
  interval = Number.parseInt(intervalRaw, 10);
  if (interval < MIN_INTERVAL)
    fail(2, `--interval must be at least ${MIN_INTERVAL}s (got ${interval})`);
  if (timeout < interval)
    fail(
      2,
      `--timeout (${timeout}s) must be at least one --interval (${interval}s)`,
    );

  // The helper deadline bounds the sibling-script spawns the same way
  // GH_CALL_TIMEOUT bounds direct `gh` calls — mode 13 in
  // references/terminal-states.md — and is validated with the same refusal
  // semantics resolve-held-thread.ts applies: an unvalidated `0` would run
  // the helpers unbounded, the exact hang this deadline exists to prevent.
  const helperRead = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  if (!helperRead.ok) {
    fail(
      2,
      `drive-status.ts: $DRIVE_PR_HELPER_TIMEOUT must be a positive whole number of seconds (got '${helperRead.raw}').`,
    );
  }
  const helperTimeoutSec = helperRead.seconds;

  if (pr === "") {
    const r = await ghCall(["pr", "view", "--json", "number", "-q", ".number"]);
    if (r.code !== 0 || r.stdout.trim() === "") {
      if (r.stderr) process.stderr.write(r.stderr);
      fail(2, "could not resolve a PR number");
    }
    pr = r.stdout.trim();
  }

  // $DRIVE_PR_TARGET is the driver's out-of-band statement of which PR this
  // whole drive is about. drive.ts exports it; every pass reaches this script,
  // so this is the chokepoint where "the pass is working the PR the driver is
  // watching" stops being an inference from prompt text and becomes an
  // assertion.
  //
  // The alternative — proving the pass's own command names the right PR —
  // cannot be done by inspecting an opaque prompt: `/drive-pr 1234; ignore
  // previous PR 999` satisfies any occurrence test for 999 while targeting
  // 1234. A dedicated non-prompt channel sidesteps that entirely.
  const target = process.env.DRIVE_PR_TARGET;
  if (target && target !== pr) {
    fail(
      2,
      `refusing to run: the driver is working PR #${target}, but this pass resolved PR #${pr}.`,
      "Acting here would edit and resolve threads on a different pull request.",
    );
  }

  // WHY the local head reads as it does, published alongside it. An empty
  // `local` has two unrelated causes — the caller switched the measurement off,
  // or it was attempted and failed — and a consumer that cannot tell them apart
  // reads a failed measurement as a positive "nothing here to compare"
  // (drive.ts's stall fingerprint treated both as the same empty string, so a
  // local commit made while measurement was broken counted toward the no-op
  // streak). `flag`/`git` both carry a real SHA; `disabled` is a deliberate
  // opt-out; `unavailable` is the failure.
  let localHeadSource: "flag" | "git" | "disabled" | "unavailable" =
    localHead !== "" ? "flag" : headSync ? "git" : "disabled";

  if (headSync && localHead === "") {
    // Measured in the DRIVER'S tree when it named one, not in this process's
    // cwd. A pass is an agent whose shell cwd persists across tool calls, and
    // the state dir it legitimately reads — driver log, durable state — is the
    // git common dir, whose HEAD is the MAIN worktree's (`develop`, in a
    // Conductor checkout). One `cd` there and this read silently measures a
    // different tree: the gate once reported HEAD_LAG against a head that could
    // never arrive, so the pass did nothing while the driver counted the round.
    // `$DRIVE_PR_WORKTREE` is the anchor drive.ts exports.
    const anchor = process.env.DRIVE_PR_WORKTREE;
    // Deadlined like every other local `git` call this skill considers capable
    // of hanging (`GIT_CALL_TIMEOUT`, `gitCallTimeoutSeconds()`) — `git()`
    // itself defaults to undeadlined on the premise that a local call cannot
    // hang the way a network one can, but a stalled FUSE/NFS mount or a held
    // filesystem lock defeats that premise, and this read feeds a fail-closed
    // guard that must not block forever waiting to fail closed.
    const r = await git(["rev-parse", "HEAD"], {
      stderr: "ignore",
      env: gitIdentityEnv(),
      timeoutSec: gitCallTimeoutSeconds(),
      ...(anchor ? { cwd: anchor } : {}),
    });
    localHead = r.code === 0 ? r.stdout.trim() : "";
    // Verify the IDENTITY of the tree the read answered for, not the shape of
    // its cwd. "Is cwd inside a git DIRECTORY" misses the cwd that actually
    // poisons a pass, the MAIN WORKTREE (a real worktree, just the wrong one),
    // and a leaked git-hook env (`GIT_DIR` and `GIT_WORK_TREE`) makes `git
    // rev-parse HEAD` answer for that tree even with `cwd: anchor`. Comparing
    // `--show-toplevel` against the driven tree catches both shapes: the
    // leaked env makes THIS call answer for the wrong tree too, so it
    // disagrees with `anchor`; reading from inside `.git` with no anchor set
    // fails outright (git refuses `--show-toplevel` there). Unreadable beats
    // wrong: `unavailable` disarms the head-sync guard and produces no stall
    // fingerprint, where a confidently wrong SHA wedges the drive.
    if (localHead !== "") {
      const topRes = await git(["rev-parse", "--show-toplevel"], {
        stderr: "ignore",
        env: gitIdentityEnv(),
        timeoutSec: gitCallTimeoutSeconds(),
        ...(anchor ? { cwd: anchor } : {}),
      });
      const top = topRes.code === 0 ? topRes.stdout.trim() : "";
      // Neither side compares as a raw string: `anchor` is untrusted env input,
      // not symlink-resolved as `--show-toplevel` is (macOS's `/var` →
      // `/private/var`), and on Windows separators and per-component casing can
      // differ, where any case-fold heuristic either misses a real difference
      // or conflates distinct directories on a case-sensitive volume. Both
      // sides go through the same canonicalization (`realpathSync`, which
      // returns the on-disk name and casing) and compare verbatim, so the
      // filesystem decides identity. A resolution failure on either side is
      // grounds to refuse. `top === ''` (the `--show-toplevel` call failed)
      // short-circuits before `boundedRealpath`: `realpathSync('')` resolves to
      // this process's cwd, routinely `anchor` itself, which would turn a
      // git-call failure into a match.
      const [topReal, anchorReal] =
        anchor && top !== ""
          ? await Promise.all([
              boundedRealpath(top, gitCallTimeoutSeconds()),
              boundedRealpath(anchor, gitCallTimeoutSeconds()),
            ])
          : [null, null];
      const mismatch = anchor
        ? topReal === null || anchorReal === null || topReal !== anchorReal
        : top === "";
      if (mismatch) {
        console.error(
          anchor
            ? `refusing to measure local HEAD — resolved worktree '${topReal ?? top ?? "(unresolved)"}' does not match the driven tree '${anchorReal ?? anchor}'`
            : "refusing to measure local HEAD from outside a working tree — it cannot answer for this one",
        );
        localHead = "";
      }
    }
    // No git context (or a detached probe) leaves nothing to compare against.
    // Announce the downgrade rather than silently skipping a guard the caller
    // believes is armed.
    if (localHead === "") {
      localHeadSource = "unavailable";
      console.error(
        "no local HEAD available; replication-lag guard is OFF for this run",
      );
      headSync = false;
    }
  }

  const repoRes = await cachedRepoView([
    "--json",
    "owner,name",
    "-q",
    '.owner.login + " " + .name',
  ]);
  if (repoRes.code !== 0) {
    if (repoRes.stderr) process.stderr.write(repoRes.stderr);
    fail(2, "could not resolve the repository");
  }
  const [owner, repo] = repoRes.stdout.trim().split(" ");
  // Exit 0 with empty or single-token stdout leaves these undefined, and every
  // later call then asks for `repos/undefined/undefined/...`, 404s, and reports
  // INDETERMINATE three times over — naming the check-run read as the fault
  // when repository resolution was. The `pr`
  // resolution above already treats empty stdout as failure; same rule here.
  if (!owner || !repo) {
    fail(2, "could not resolve the repository (gh returned no owner/name)");
  }

  let waitingCache: WaitingEvaluationCache | undefined;
  if (!once) {
    try {
      waitingCache = new WaitingEvaluationCache(waitingChecksMaxAgeMs());
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  }
  const ctx = {
    ...definedFields({ waitingCache }),
    pr,
    owner,
    repo,
    botsOnly,
    headSync,
    localHead,
    inheritedHead,
    driveStateScript: join(here, "drive-state.ts"),
    listThreadsScript: join(
      here,
      "..",
      "..",
      "resolve-review-comments",
      "scripts",
      "list-unresolved-threads.ts",
    ),
    summaryScript: join(here, "summary-findings.ts"),
    helperTimeoutSec,
  };

  const report: StatusReport = emptyReport();

  function countOrNull(n: number | null): number | null {
    return n;
  }

  // Mirrors drive.ts's arming of $DRIVE_PR_REFLECT_DUE from the SAME durable
  // state and through the SAME shared predicate, so the /reflect duty fires on
  // interactive runs with no drive.ts in the chain (the env var never exists
  // there) and cannot answer differently from the loop's own copy — three
  // divergent formulations of one duty drift apart. Attempts count passes on an
  // unmoving head, which is still work a /reflect should see. Best-effort by
  // design — the duty is advisory, and unreadable state already hard-stops the
  // paths that must not proceed on it. Read AFTER case 0's bump-round AND its
  // `--bump-attempt` bump (emit runs last), so the value reflects the pass
  // being reported rather than the one before it — a caller that omits
  // `--bump-attempt` still gets a value, just one still missing this pass's own
  // attempt, which is why the interactive path (SKILL.md § 1) always passes the
  // flag now. `drive.ts` re-derives it post-bump for the env-var transport
  // itself, from the same durable state.
  //
  // Bounded by $DRIVE_PR_HELPER_TIMEOUT like every other helper spawn here: an
  // unbounded one parks `--json` (and, through it, the drive loop) on a hung
  // child, and `run` reports a timeout as a non-zero code, which this already
  // degrades to `false`.
  async function reflectDue(): Promise<boolean> {
    // Only when reflection is on: with it off there is no store for the
    // lesson to reach, and the duty would only cost a pass.
    if (reflectionSwitch() !== true) return false;
    const r = await run(tsArgv(ctx.driveStateScript, ["get", pr]), {
      stderr: "ignore",
      timeoutSec: ctx.helperTimeoutSec,
    });
    if (r.code !== 0) return false;
    try {
      const rawAfter = process.env.DRIVE_PR_REFLECT_AFTER ?? "3";
      const after = isDigits(rawAfter) ? Number.parseInt(rawAfter, 10) : 3;
      return (
        reflectDepthPastLast(JSON.parse(r.stdout) as ReflectCounters) > after
      );
    } catch {
      return false;
    }
  }

  /**
   * `structuralEscalationDue` plus the invariant text the last
   * acknowledgment recorded — both read from the SAME durable
   * state, through the SAME `drive-state.ts get` call, on exactly the terms
   * `reflectDue` above is read on: bounded by `$DRIVE_PR_HELPER_TIMEOUT`,
   * best-effort, degrading to `{ due: false, invariant: null }` on any
   * unreadable answer. One read for the pair rather than two separate calls —
   * a second subprocess spawn buys nothing here and risks the two answers
   * disagreeing if state changed between them.
   *
   * Read AFTER `recordRoundPaths` has filed this round's anchors — case 0 files
   * them and only then calls `emit`, which runs this — so the field reports the
   * pass it describes rather than the one before it. That is the same
   * off-by-one `--bump-attempt` closed for `reflectDue`, which went unnoticed
   * there for a long time and is cheaper to simply not repeat.
   *
   * On every OTHER exit it reports whatever durable state already says, which
   * is the honest answer: an escalation armed two rounds ago is still owed
   * whether or not this particular gate reached a round.
   *
   * ADVISORY, like `reflectDue`: neither field ever reaches `report.state` or
   * changes an exit code. A round gate that could refuse to run because two
   * rounds touched one file would stop drives that are converging perfectly
   * well on a file they are legitimately still editing.
   */
  async function structuralEscalationStatus(): Promise<{
    due: boolean;
    invariant: string | null;
  }> {
    const r = await run(tsArgv(ctx.driveStateScript, ["get", pr]), {
      stderr: "ignore",
      timeoutSec: ctx.helperTimeoutSec,
    });
    if (r.code !== 0) return { due: false, invariant: null };
    try {
      const state = JSON.parse(r.stdout) as EscalationState;
      return {
        due: structuralEscalationArmed(state),
        invariant: structuralEscalationInvariant(state),
      };
    } catch {
      return { due: false, invariant: null };
    }
  }

  /**
   * File this round's finding anchors into durable state, so the recurrence
   * check has something to compare the NEXT round against.
   *
   * Called from case 0 ONLY, immediately after `bump-round` has succeeded —
   * never from `emit`, which every exit path reaches. `record-paths` keys
   * itself to the state's CURRENT round, so on any exit where the bump did not
   * run, `rounds` still names the PREVIOUS round and this call would overwrite
   * that round's anchors with this gate's snapshot. Two rounds' findings
   * collapsed into one entry is not a missed signal, it is a fabricated one:
   * the pair it was going to be compared against disappears.
   *
   * Its remaining guards are load-bearing on the same terms:
   *
   *   `!noCount` — `--no-count` is this skill's statement that an invocation
   *   is a re-read, not a pass entry, and case 0 skips the bump under it for
   *   exactly that reason. The same stale-round overwrite follows, so the
   *   guard is restated here rather than inherited from the caller.
   *
   *   A MEASURED path list. `openThreadPaths` is `null` on every gate that
   *   returned before enumerating, and recording `[]` there would file the
   *   positive claim "no file drew a finding this round" — breaking the
   *   consecutive-round chain on evidence nobody gathered, which silences the
   *   signal rather than merely failing to arm it.
   *
   *   BEST-EFFORT. A failed write costs a deferred signal on an advisory field,
   *   never a verdict; the round bump above already hard-stops on the durable
   *   state being unwritable, so this cannot be the first place that fault is
   *   discovered. "Best-effort" means the failure does not block the round, not
   *   that it is invisible: `bump-round` hard-stopping on the SAME class of
   *   fault does not prove THIS write succeeded — it is a separate call, with
   *   its own lease and timeout window, and a report reaching
   *   `structuralEscalationDue` afterwards reads whatever durable state already
   *   had, silently stale by exactly this round's missing entry. So a non-zero
   *   exit here is reported on stderr — not escalated to a state or exit-code
   *   change, which would turn an advisory field into a gate over a network
   *   call.
   *
   *   `record-paths`'s OWN stderr is PASSED THROUGH, not discarded — the same
   *   convention `parked-keys` above uses, and for the same reason: a
   *   non-zero exit is not the only case `record-paths` has something to say.
   *   It also warns, on stdout-success, when the 200-path-per-round cap
   *   truncates real anchor evidence (`ROUND_PATHS_MAX_PER_ROUND` in
   *   `lib/state/schema.ts`) — a case the exit-code branch below cannot see,
   *   since the write still succeeds. Discarding that warning here made a
   *   repeated file sorted outside the retained 200 paths silently vanish
   *   from the recurrence signal with nothing anywhere saying so.
   */
  async function recordRoundPaths(): Promise<void> {
    if (noCount) return;
    const paths = report.openThreadPaths;
    if (paths === null) return;
    // `--stdin` rather than one `--path` argument per path: a round with
    // enough long paths can push the child's argv past the ~32KB Windows
    // command-line limit, silently failing to record this round's anchors.
    const args = ["record-paths", pr, "--stdin"];
    const r = await run(tsArgv(ctx.driveStateScript, args), {
      stdout: "ignore",
      stderr: "inherit",
      timeoutSec: ctx.helperTimeoutSec,
      stdin: paths.length > 0 ? `${paths.join("\n")}\n` : "",
    });
    if (r.code !== 0) {
      process.stderr.write(
        `drive-status: could not record this round's finding anchors for #${pr} (record-paths exited ${r.code}) — structuralEscalationDue is reporting the previous round's durable state, not this one\n`,
      );
    }
  }

  /**
   * Base drift, measured ONCE per invocation at the moment the round is
   * reported — the earliest point in a round anything reads state, and the
   * only one where acting on drift is still cheap (lib/base-drift.ts argues
   * why, and what "cheap" costs when the answer arrives at the announce gate
   * instead).
   *
   * The placement's load-bearing properties:
   *
   *   BEST-EFFORT, ALWAYS. It never reaches `report.state`, never changes an
   *   exit code, and every failure degrades to `null`. A convergence verdict
   *   that could hinge on whether a `git fetch` succeeded would be a verdict
   *   the network gets a vote in.
   *
   *   ONCE, NOT PER POLL. `emit()` runs at the single exit, not inside the
   *   wait loop, so a gate that sits at `--timeout` polling every 30s still
   *   fetches once.
   *
   *   COUNTING INVOCATIONS ONLY, the same rule the replied-thread sweep uses
   *   and for the same reason: `--no-count` is this skill's statement that an
   *   invocation is a re-read rather than a pass entry. finish-round.ts's
   *   head-sync wait and announce-merge-ready.ts's re-read both carry it, and
   *   neither is a round that could act on drift — so neither pays for a
   *   network round-trip to be told about it.
   */
  let driftMemo: BaseDrift | null | undefined;
  async function baseDrift(): Promise<BaseDrift | null> {
    if (driftMemo !== undefined) return driftMemo;
    driftMemo = null;
    const baseBranch = report.baseRefName;
    if (noCount || baseBranch === "") return driftMemo;
    const seconds = fetchTimeoutSeconds();
    if (!seconds.ok) return driftMemo;
    // Anchored to `DRIVE_PR_WORKTREE` for the same reason the local-head read
    // above is: pass cwd persists across tool calls, and a `cd` to the main
    // checkout or another worktree would otherwise make `--show-toplevel`
    // resolve THAT tree's root, silently measuring drift for the wrong
    // checkout. `env: gitIdentityEnv()`
    // for the same reason the local-head reads above carry it: a leaked
    // `GIT_DIR`/`GIT_WORK_TREE` pair overrides `-C`/`cwd` alike, so without it
    // this call — and every call `probeBaseDrift` makes after it — can answer
    // for the main worktree instead of `anchor`.
    const anchor = process.env.DRIVE_PR_WORKTREE;
    const identityEnv = gitIdentityEnv();
    const rootRes = await git(["rev-parse", "--show-toplevel"], {
      stderr: "ignore",
      env: identityEnv,
      timeoutSec: gitCallTimeoutSeconds(),
      ...(anchor ? { cwd: anchor } : {}),
    });
    if (rootRes.code !== 0 || rootRes.stdout.trim() === "") return driftMemo;
    const root = rootRes.stdout.trim();
    // Same precondition base-sync.ts fails closed on before its own fetch:
    // `probeBaseDrift` always fetches through `origin`, which is wrong
    // whenever `origin` is not the PR's own repository (a fork clone, or a
    // `gh`/git disagreement). This read is best-effort like the rest of
    // `baseDrift()`, so a mismatch just degrades to `null` rather than
    // failing the gate — but it must not silently measure drift off the
    // wrong repository's history.
    const originCheck = await verifyOriginIsPrRepo(
      git,
      root,
      `${owner}/${repo}`,
      identityEnv,
    );
    if (!originCheck.ok) return driftMemo;
    // `origin` being the right REPOSITORY does not prove this WORKTREE is
    // checked out on THIS PR's branch — invoked with an explicit PR from an
    // unrelated branch or worktree (`DRIVE_PR_WORKTREE` unset or pointed
    // elsewhere), this call would otherwise happily measure and publish
    // drift for whatever is checked out here, mislabeled with this PR's
    // number. `verifyCheckoutIsPrHead`
    // is the same branch-name-plus-ancestor check `base-sync.ts` guards this
    // identical hazard with: the ancestor check alone is NOT sufficient — a
    // sibling branch created from, or later merged with, the PR's head has
    // `apiHead` as an ancestor of its own HEAD too, so it would pass an
    // ancestor-only check and publish that sibling's files and overlap as
    // this PR's drift. This path never
    // has a human-facing message to spend on naming which half failed, so
    // both degrade to the same silent "no drift published" as every other
    // best-effort branch in this function.
    if (report.apiHead === "" || report.headRefName === "") return driftMemo;
    const headCheck = await verifyCheckoutIsPrHead(
      git,
      root,
      report.headRefName,
      report.apiHead,
      identityEnv,
    );
    if (!headCheck.ok) return driftMemo;
    const probe = await probeBaseDrift(
      git,
      root,
      baseBranch,
      seconds.seconds,
      identityEnv,
    );
    if (probe.ok) driftMemo = probe.drift;
    return driftMemo;
  }

  async function emit(code: number): Promise<void> {
    const drift = await baseDrift();
    if (json) {
      // Computed only here, like `reflectDue` beside it — never used outside
      // the JSON payload, so hoisting it above this branch (the way `drift`
      // has to be, since the plain-text path's stderr narration reads it
      // below) would cost the non-`--json` caller a `drive-state.ts get`
      // subprocess call for a field it never reports.
      const escalation = await structuralEscalationStatus();
      // ADVISORY, like `reflectDue`: read from the snapshot the dev-dashboard
      // collector already published, never sampled here.
      const fleetHealth = readFleetHealthAdvisory(
        Number.parseInt(pr, 10),
        Date.now(),
      );
      process.stdout.write(
        `${JSON.stringify({
          state: report.state,
          exit: code,
          pr: Number.parseInt(pr, 10),
          reason: report.reason,
          reflectDue: await reflectDue(),
          structuralEscalationDue: escalation.due,
          // The claim the last acknowledgment recorded via
          // `set-escalated --invariant`, echoed back ONLY while
          // `structuralEscalationDue` is true — `null` while
          // clean, and `null` (not `''`) when armed but no round ever stated
          // one. See `structuralEscalationInvariant`'s own doc for why the
          // two `null` causes are not distinguished here: either way there is
          // no prior claim to check this round's finding against.
          structuralEscalationInvariant: escalation.invariant,
          // PR-scoped fleet-health suspicions for THIS PR (review carousel,
          // follow-up depth) — a count crossing a threshold, never a finding,
          // and never a change to `state` or the exit code. `[]` when the
          // snapshot is absent, which is the ordinary case off the dashboard
          // host. See SKILL.md § 1.
          fleetHealth: {
            warnings: fleetHealth.warnings,
            snapshotAgeSec: fleetHealth.snapshotAgeSec,
            stale: fleetHealth.stale,
            partial: fleetHealth.partial,
          },
          head: {
            api: report.apiHead,
            local: localHead,
            localSource: localHeadSource,
          },
          // `drift` is `null` on a `--no-count` re-read and on any unreadable
          // probe — never a zeroed measurement, which would be the positive
          // claim "the base has not moved".
          base: { refName: report.baseRefName, oid: report.baseHead, drift },
          // `null` when no snapshot measured it — never `false`, which is the
          // positive claim "this PR is Ready for review". Same rule as the
          // work counts below.
          draft: report.isDraft,
          merge: {
            mergeable: report.mergeable,
            stateStatus: report.mergeStateStatus,
          },
          reviewer: {
            app: reviewerApp() || null,
            present: report.reviewerPresent,
            status: report.reviewerStatus,
            conclusion: report.reviewerConclusion,
            reviewedSha: report.reviewedSha,
            reviewedShaSource: report.reviewedShaSource,
          },
          work: {
            unresolvedThreads: countOrNull(report.threadsOpen),
            parkedThreads: countOrNull(report.threadsParked),
            summaryFindings: countOrNull(report.summaryTotal),
            summaryUnaddressed: countOrNull(report.summaryUnaddressed),
            parkedSummaryFindings: countOrNull(report.summaryParked),
            // WHICH items, not just how many: a count cannot tell a resolved
            // thread replaced by a new one from a round that did nothing
            // Sorted, so equality is set equality.
            unresolvedThreadKeys: report.openThreadKeys,
            summaryUnaddressedKeys: report.summaryUnaddressedKeys,
            parkedKeys: report.parkedItemKeys,
            // The evidence `structuralEscalationDue` above is derived from —
            // published for visibility, the same reason the key sets beside
            // it are. NOT the recurrence result itself: this is only THIS
            // round's own live finding-anchor paths (threads AND summary-only
            // findings both, despite the field's name), so with more than one
            // file open it does not say which one is the file that recurred
            // — only what this round contributed to that question. See
            // SKILL.md § 1 on `work.unresolvedThreadPaths`.
            unresolvedThreadPaths: report.openThreadPaths,
          },
          ci: report.ci,
          // The structured evidence behind `ci`: `evaluate()` has computed both
          // of these on its internal `report` object all along, but this
          // hand-built payload never included either, so `drive.ts`'s own
          // `finalStatus.failingCheckNames`/`failingCheckRunNames` reads were
          // always `undefined` and `staleRequiredFailure` could never evaluate
          // `true` in production — every earlier fix to that predicate's LOGIC
          // was polishing evidence that never actually arrived at the CLI
          // boundary.
          failingCheckNames: report.failingCheckNames,
          failingCheckRunNames: report.failingCheckRunNames,
          // The commit-status-only complement — `drive.ts` needs this to tell a
          // purely check-run- sourced failure from one that ALSO has a fresh,
          // unambiguous commit-status occurrence under the same name.
          failingStatusNames: report.failingStatusNames,
        })}\n`,
      );
    } else {
      process.stdout.write(`${report.state}\n`);
    }
    console.error(`${report.state}: ${report.reason}`);
    if (!json) {
      const fh = fleetHealthLine(
        Number.parseInt(pr, 10),
        readFleetHealthAdvisory(Number.parseInt(pr, 10), Date.now()),
      );
      if (fh !== null) console.error(fh);
    }
    // On stderr with the rest of the round's narration, so the non-`--json`
    // caller — whose stdout is the state name and nothing else — sees it too.
    if (drift !== null) {
      const line = driftLine(drift);
      if (line !== null) console.error(line);
    }
  }

  // The replied-thread reconciliation, run as part of the pass entry rather
  // than as a separately remembered command. See the header for
  // why it belongs here; these properties of the placement are load-bearing:
  //
  //   BEFORE ANY VERDICT. Every non-ROUND_READY exit ends the round, and the
  //   polling states (`4`) can sit until `--timeout` — so a sweep reached only
  //   after a verdict, or only on the verdict a pass acts on, would keep the
  //   exact leak this closes. It therefore runs on the loop's first iteration,
  //   ahead of the first `evaluate()`, and the only thing that can precede a
  //   verdict without it having run is the INDETERMINATE retry class the
  //   liveness read below degrades to — which by construction re-arms.
  //
  //   Exactly once per invocation, gated on `!noCount`. `--no-count` is
  //   already this skill's statement that an invocation is a re-read rather
  //   than a pass entry (SKILL.md §§ 3 and 6 both pass it, as does
  //   announce-merge-ready.ts), so reusing it keeps one sweep per pass instead
  //   of one per status read. `--no-reconcile` is the explicit opt-out for a
  //   caller that wants the verdict and nothing else.
  //
  //   Non-fatal TO A RE-ARMING VERDICT, and off this script's stdout. The sweep
  //   emits NDJSON there, which would corrupt the `--json` report its callers
  //   parse — so its stdout is captured and re-emitted on stderr with the rest
  //   of the round's narration. A non-zero exit never makes a round this gate
  //   could otherwise judge unjudgeable: 0 and 4 both re-arm, so the next pass
  //   sweeps again. It DOES block every member of `UNRECONCILED_STOPPERS` — the
  //   verdicts that do not re-arm — see `sweepReconciled` at the loop below for
  //   why that distinction is the whole rule rather than two competing ones.
  //   Named rather than enumerated: this copy still said "8/9/10" after exit 7
  //   joined the set, which is the second time a hand-written restatement of it
  //   drifted (the header's copy was the first).
  //
  // Deadlined like every other helper spawn here (mode 13 in
  // references/terminal-states.md) — the sweep bounds each of its OWN network
  // calls at the same env var, but nothing bounds their SUM, and an unbounded
  // one parks the gate on a stalled connection. One deadline covering N calls
  // is deliberately the tighter reading: the sweep resolves and re-holds
  // thread by thread as it iterates and every action it takes is idempotent,
  // so being cut short costs a partial sweep that the next pass entry
  // continues, not a lost one.
  //
  // SCOPED by --bots-only, forwarded verbatim. An earlier version deliberately
  // did not, reasoning that a human thread already carrying a trusted outcome
  // token has been triaged and so is not intentionally open. The canonical rule
  // (`/resolve-review-comments` § Human threads) says the opposite: a **human**
  // thread you replied to but chose not to close on the author's behalf is the
  // ONE sanctioned exception to "every comment you act on ends resolved", and
  // that exception is why continuous mode targets bot threads (`--bots-only`).
  // A replied-but-open human thread is therefore the exception itself, not a
  // leak — and this sweep runs unattended, which is precisely the act the rule
  // governs, so sweeping it closed would have turned the author's own triage
  // into the warrant for overriding their choice not to close it.
  //
  // The invariant that fix established is ONE-DIRECTIONAL, and it is worth
  // stating that way rather than as "the scopes are identical": the sweep must
  // never be WIDER than the count, so reconciliation cannot act on a thread
  // convergence does not measure. Narrower is safe, and `sweepBotsOnly` below
  // uses that room — an unattended drive sweeps bot threads even when the
  // operator asked to count human ones too, because "nobody is watching" is
  // what the human-thread exception turns on, not what the operator wanted
  // counted.
  //
  // LIVENESS FIRST, ahead of it, and failing closed. "A merged or closed PR
  // stops the loop before the round spends anything" is the contract SKILL.md
  // § 1 opens with, and `evaluate()`'s own opening snapshot is the only thing
  // that reads it — which sits BELOW this sweep, so a PR that merged since the
  // previous round got its threads resolved and its unconfirmed holds written
  // before the gate ever returned PR_NOT_OPEN. Those are mutations on a
  // finished pull request, taken by a round that was not entitled to run at
  // all; `--all-open` already scopes itself to OPEN PRs, so the embedded sweep
  // was the one caller that did not.
  //
  // A separate `gh` read, on `state` alone — the same cheap read, for the
  // same reason, as the liveness probe on `evaluate()`'s missing-field path.
  // It gates the sweep ONLY: the verdict still comes from the full snapshot
  // below, so a stale or racing answer here can suppress a sweep but can never
  // decide the round.
  //
  // Being a SEPARATE snapshot from both the sweep's own mutations and
  // `evaluate()`'s is inherent, not an oversight: GitHub offers no "resolve
  // this thread if the PR is still open", so every liveness guard in this
  // skill is check-then-act (`guarded-push.ts` re-checks at the instant of
  // the push; `announce-merge-ready.ts` re-reads immediately before AND after
  // its POST and says outright that narrowing the window is not closing it).
  // What IS closed here is the direction that outlives the window: a decision
  // taken on a stale read can never license a verdict that ends the drive,
  // because that permission comes from `sweepReconciled` below, not from this
  // read.
  //
  // An UNREADABLE answer does not merely skip the sweep, though — that is the
  // whole reason this sits inside the loop rather than above it. "Skipping
  // costs a deferral to the next pass entry" is true only where there IS a next
  // pass, and the verdicts this sweep exists for are precisely the ones that do
  // not re-arm — `UNRECONCILED_STOPPERS`, named rather than restated for the
  // same reason as above: this copy still listed the retired PR_IS_DRAFT. Every
  // one of them ends the drive, so a pass that skipped the sweep on a transient
  // `gh` blip and then returned one of them would recreate the indefinite
  // unresolved-thread leak this sweep closes, with nothing left to retry it. So
  // an unreadable state degrades the WHOLE pass to INDETERMINATE — the retry
  // class, sharing `evaluate()`'s own bounded budget below — and no terminal
  // verdict is ever reported by a pass that skipped the sweep for a reason that
  // might clear. A read that positively says the PR is finished is a different
  // matter: it will not clear, and `evaluate()` is about to return PR_NOT_OPEN
  // for it anyway.
  const deadline = Date.now() + timeout * 1000;
  /**
   * What is LEFT of the caller's `--timeout`. Non-positive means spent.
   *
   * ONE function, read by every site in this loop that is about to spend time,
   * because the deadline used to be consulted at `case 4` alone and every
   * other path overran it by construction: `case 1` slept a full interval
   * without looking, the spawn block floored an already-expired budget to one
   * second, and the loop top let `evaluate()` begin on a spent budget. The
   * invariant is what to preserve — no site spends time it has not checked for
   * — rather than a tally of which sites currently do, since that number is
   * derivable from the control flow below and goes stale the moment another
   * wait or spawn is added.
   *
   * Worth recording because it is why this is one bug rather than several:
   * every such site is a different instance of the same omission.
   */
  const budgetLeftMs = (): number => deadline - Date.now();
  /**
   * Whether a further `--interval` sleep still fits inside `--timeout`.
   *
   * The predicate every waiting site stops on, so the answer cannot differ by
   * site. Refusing a sleep that would not fit is the same rule as refusing to
   * act after the deadline has passed, stated one poll earlier: `--timeout 30
   * --interval 30` must not return at 50s because a sweep spent the first 20.
   */
  const intervalFits = (): boolean => budgetLeftMs() >= interval * 1000;
  let queryErrors = 0;
  /**
   * The caller forbade the sweep on this invocation. `--no-reconcile` says so
   * outright; `--no-count` says the invocation is a mid-round re-read rather
   * than a pass entry, and one sweep per pass is the point of running it from
   * the gate at all.
   */
  const sweepSuppressed = noCount || noReconcile;
  /**
   * Scope for the SWEEP, which is not always the scope for the COUNT.
   *
   * `--bots-only` narrows both, as before. What this adds is that an UNATTENDED
   * drive sweeps bot threads whether or not the operator asked to count only
   * those: `$DRIVE_PR_TARGET` exists exactly when `drive.ts` spawned this gate,
   * and `drive.ts` is the unattended runner. Resolving a human's
   * replied-but-open thread with nobody watching is the act
   * `/resolve-review-comments` § Human threads reserves, and it does not become
   * permissible because the operator also wanted human threads counted.
   *
   * The two scopes may therefore differ, but only in the safe direction. The
   * rule the earlier fix established is that reconciliation must never act on
   * a thread convergence does not measure — i.e. the sweep must not be WIDER
   * than the count. Narrower is fine: those threads are still counted, so an
   * unattended drive simply cannot converge over a replied human thread, which
   * is the correct outcome — a human decides when that one closes.
   */
  const sweepBotsOnly = botsOnly || process.env.DRIVE_PR_TARGET !== undefined;
  /**
   * Reconciliation is SETTLED for this invocation — the sweep succeeded, the
   * PR positively read finished, or the caller forbade it. Suppresses the
   * probe on later iterations; says nothing about whether anything was
   * actually reconciled.
   */
  let sweepSettled = sweepSuppressed;
  /**
   * ONE fact: a sweep ran on this invocation and exited 0. Nothing else sets
   * it — not a flag, not a liveness read, not "the pass entry probably did it".
   *
   * DENY BY DEFAULT is the whole design, and it is the correction to how this
   * guard was built. It started as "8/9/10 need a successful sweep" and then
   * acquired one exemption per reported signal: `--no-reconcile`, then
   * `--no-count`, each argued individually and each a hole. `--no-count` was
   * the clearest demonstration that per-signal reasoning does not work here: it
   * "proves the pass entry already swept" only if that entry swept
   * SUCCESSFULLY, and a counting pass deliberately returns ROUND_READY over a
   * FAILED sweep — so a mid-round `--no-count` re-read inside exactly that
   * round would have certified a drive-ending verdict for a sweep that never
   * succeeded.
   *
   * So no signal is an exemption any more. A suppressed sweep (either flag)
   * simply never sets this, which means such an invocation cannot certify one
   * of `UNRECONCILED_STOPPERS` — and that is the correct answer for both
   * flags, for the same reason, without either being special-cased.
   */
  let sweepReconciled = false;
  /**
   * ONE fact, narrower than `!sweepReconciled`: the sweep SUBPROCESS actually
   * spawned on this invocation (the `run` call a few dozen lines down) and
   * exited nonzero. Never set by a skip — not the loop-top spent-budget skip,
   * not the "liveness read just spent the budget" skip, not the
   * skippedAsFinished liveness path. `!sweepSuppressed && !sweepReconciled`
   * looks like the same thing and is not: both skip paths above leave
   * `sweepSuppressed` false too (neither flag was passed), so that predicate is
   * true whenever the sweep merely never got a turn — which, for CONVERGED
   * specifically, produced a false INDETERMINATE on a genuinely converged PR
   * whose sweep was skipped for budget, not attempted and failed. Only this
   * flag distinguishes "ran and failed" from "never got a turn".
   */
  let sweepRanAndFailed = false;
  /**
   * The sweep was skipped because the liveness read said the PR was finished
   * — a decision the evaluation immediately below can contradict, since a
   * closed PR may be REOPENED.
   */
  let skippedAsFinished = false;
  /** Budget for skip retractions; exhausting it degrades, never permits. */
  let skipRetractions = 0;

  /**
   * Report an unreconciled pass as the retry class rather than a verdict.
   * Returns the exit code when this invocation must stop, or `null` to loop.
   * Re-arms the probe, so the retry re-reads liveness and re-attempts the
   * sweep instead of re-deriving the same answer from a stale decision.
   */
  async function degrade(reason: string): Promise<number | null> {
    report.state = "INDETERMINATE";
    report.reason = reason;
    // Not re-armed when a flag suppressed the sweep: the caller has forbidden
    // it, so retrying the probe could only produce the same answer, more
    // slowly. The bounded budget below still ends the invocation honestly.
    if (!sweepSuppressed) sweepSettled = false;
    queryErrors += 1;
    // BOTH bounds, not just the count. `--timeout` is the deadline the caller
    // advertised, and this helper is reached from paths that did not exist when
    // the only deadline check was placed down in `case 4` — so a count-only
    // bound overran it: `--timeout 5 --interval 5` slept twice and returned
    // after 10s+, and a clamped sweep before it widened the overrun further.
    // Checked BEFORE the sleep, since sleeping past a deadline that has already
    // passed is the overrun.
    if (once || queryErrors >= MAX_QUERY_ERRORS || !intervalFits()) {
      await emit(1);
      return 1;
    }
    console.error(
      `${reason} (attempt ${queryErrors}/${MAX_QUERY_ERRORS}); retrying`,
    );
    await sleep(interval);
    return null;
  }

  let iterations = 0;

  for (;;) {
    /** The caller's `--timeout` is gone. Read once per iteration. */
    const spent = budgetLeftMs() <= 0;

    // NO SPAWN EVER STARTS ON A SPENT BUDGET. The ONE exemption is the FIRST
    // `evaluate()`, and it is deliberately that narrow.
    //
    // Getting the scope of that exemption right took several attempts, so the
    // two wrong shapes are worth keeping written down. First the guard sat
    // inside `if (!sweepSettled)`, which covered that block's spawns and
    // nothing else — a settled sweep skipped it and `evaluate()` began past the
    // deadline anyway. Then it moved here but exempted the whole first
    // ITERATION, which still let a spent budget start a liveness read and a
    // reconciliation subprocess, so `--timeout` could be consumed entirely by
    // work that is not the promised evaluation and `evaluate()` would then run
    // on top of it.
    //
    // The distinction that resolves it: the evaluation is what the caller is
    // PROMISED (`--once` promises exactly one, so a `--timeout` shorter than
    // this process's own startup must still yield a verdict rather than an
    // INDETERMINATE reporting that nothing was attempted). The sweep is not —
    // skipping it costs a deferral to the next pass entry, which is a cost
    // this loop already accepts everywhere else, and an unreconciled pass
    // still cannot report a drive-ending verdict because the guard at the
    // bottom withholds every one of them on `!sweepReconciled`. So on a spent
    // budget the sweep is what gives way, and the evaluation is what survives.
    //
    // Reachable by more than one path, which is why it is a loop-top guard
    // rather than a check bolted to whichever site was last reported: `case 1`
    // and `case 4` both sleep and `continue`, and the skip-retraction
    // `continue`s without sleeping at all — a sleep is permitted whenever a
    // full interval fits, so an iteration can legitimately begin with the
    // budget at zero.
    //
    // `degrade()` rather than a bare return: an iteration stopped here may not
    // have completed reconciliation, so it must not judge (the rule at the
    // bottom of this loop), and `degrade` reports the retry class, charges the
    // error budget, and — with the deadline gone — stops on its own
    // `intervalFits()` check rather than looping.
    if (iterations > 0 && spent) {
      const stop = await degrade(
        `#${pr}'s ${timeout}s budget was spent before this iteration could reconcile and judge, so it will not judge unreconciled`,
      );
      if (stop !== null) return stop;
      continue;
    }
    iterations += 1;

    // `!spent` applies on EVERY iteration, the first included — that is the
    // whole of the fix. A first iteration with nothing left skips straight to
    // the evaluation it owes the caller, rather than spending the overrun on a
    // sweep whose failure mode is merely a deferral.
    //
    // RECORDED, not silent. That skip is what makes a pass reach a verdict
    // with no sweep attempted, and the guard at the bottom needs to know it
    // happened — reported as a high-severity finding on exactly this fix.
    if (!sweepSettled && spent) {
      console.error(
        `drive-status.ts: skipping the replied-thread reconciliation sweep for #${pr} — the ${timeout}s budget was already spent when this iteration began, so it is deferred to the next pass entry`,
      );
    }
    if (!sweepSettled && !spent) {
      // An EXPIRED budget is not a small budget, which is what the `!spent`
      // condition above is protecting: the sweep spawn floors its deadline at
      // one second (`run` treats 0 as "no deadline", so the floor itself has to
      // stay), and without that guard the floor turned a spent budget into a
      // fresh subprocess plus a whole `evaluate()`.
      //
      // CLAMPED TO THE REMAINING BUDGET, not merely deadlined. `ghCall`
      // applies `GH_CALL_TIMEOUT` (30s), which is INDEPENDENT of `--timeout`
      // — so on a gate asked for 30s this one read could spend the whole
      // budget on its own and then hand the sweep below a spent one.
      //
      // Through the shared chokepoints rather than a raw `run(['gh', …])`:
      // this skill has a guardrail test asserting every outbound `gh` call
      // routes through `ghCall`, and taking the shortcut here traded this
      // finding for that guard (it went red, which is what the test is for).
      // `readPrState` is one of those chokepoints and carries the same clamp.
      //
      // A conditional REST read, not `gh pr view`: the state alone
      // is all this probe asks for, so an unchanged PR answers `304` and spends
      // nothing from the GraphQL bucket a handful of parallel drives exhaust.
      // The evaluation's own snapshot below stays GraphQL — it compares fields
      // against each other, and REST and GraphQL disagree on some of them.
      const live = await readPrState(pr, {
        timeoutSec: Math.max(1, Math.ceil(budgetLeftMs() / 1000)),
        caller: "sweep",
      });
      // An EXPLICIT closed set, in both directions. `OPEN` sweeps; `CLOSED` and
      // `MERGED` are the only values that positively mean finished. Everything
      // else — a failed read, a malformed answer, a state GitHub adds later —
      // is unreadable, not finished: treating "not exactly OPEN" as a confirmed
      // terminal state let an unrecognised value skip the sweep and then permit
      // a verdict that ends the drive. `readPrState` only ever returns one of
      // the three.
      if (!live.ok) {
        const stop = await degrade(
          // Named as the transient failure it is, in `evaluate()`'s own
          // vocabulary for the identical condition: this probe runs ahead of
          // that read, so it is what an operator sees first when `gh` is
          // failing, and describing the same fault in different words
          // depending on which call noticed it is how a diagnostic stops being
          // one. `reason` says whether the read failed or came back
          // unrecognised — both are the retry class, since neither is a
          // confirmed finished PR.
          `cannot read PR #${pr}'s state (${live.reason}) — a transient failure, not a missing-field error — to decide whether the replied-thread reconciliation sweep may run — refusing to judge this round, since a verdict that does not re-arm would strand the sweep for good`,
        );
        if (stop !== null) return stop;
        continue;
      }
      const liveState = live.state;
      if (liveState !== "OPEN") {
        sweepSettled = true;
        skippedAsFinished = true;
        // Positively finished, so there is nothing to reconcile and
        // `evaluate()` is about to return PR_NOT_OPEN. `sweepReconciled`
        // deliberately stays false, and `skippedAsFinished` records WHY the
        // skip happened: GitHub permits a closed PR to be REOPENED, so this
        // read can be contradicted by the evaluation a moment later, and the
        // check just below the evaluation retracts the skip when it is.
        console.error(
          `drive-status.ts: skipping the replied-thread reconciliation sweep for #${pr} — it is ${liveState}, and a finished pull request stops the round before it spends anything`,
        );
      } else if (budgetLeftMs() <= 0) {
        // THE LIVENESS READ JUST SPENT THE BUDGET. Re-read it rather than
        // trusting the answer from the top of the iteration: the read above
        // is an outbound call, so an iteration that began with budget can
        // arrive here with none, and the floor below would then turn that
        // into a one-second helper spawn — the same "expired budget is not a
        // small budget" defect one call later.
        //
        // A SKIP, not a degrade, and deliberately so: this is the same
        // give-way rule as the loop top. The sweep is not what the caller is
        // promised, and skipping it costs a deferral to the next pass entry —
        // whereas degrading here would deny the promised first `evaluate()`
        // to a caller whose budget the liveness read happened to consume.
        // `sweepReconciled` stays false, so the guard below still withholds
        // every verdict that cannot be accounted for without a sweep.
        console.error(
          `drive-status.ts: skipping the replied-thread reconciliation sweep for #${pr} — the ${timeout}s budget was spent before it could start, so it is deferred to the next pass entry`,
        );
      } else {
        // Clamped to what is LEFT of `--timeout`, not just to the helper's own
        // deadline. The two are independent, and the loop only checks the
        // deadline down in `case 4` — so an unclamped sweep blocks for up to
        // `$DRIVE_PR_HELPER_TIMEOUT` (120s by default) before any deadline
        // check runs, and `--timeout 30` could sit for two minutes. Repeated
        // sweeps near the deadline overshoot again. A caller that asked for 30s
        // gets a sweep bounded by 30s.
        //
        // Never below 1: `run` treats 0 as "no deadline", so flooring at 1
        // keeps a sub-second budget from silently becoming an unbounded call.
        // The floor covers ONLY a positive sub-second remainder now — an
        // expired budget never reaches here, because the guard at the top of
        // this block refuses the whole iteration. The loop is about to end on
        // the deadline anyway, and the sweep is idempotent, so being cut off
        // costs a partial sweep the next pass entry continues.
        const leftSec = Math.max(1, Math.ceil(budgetLeftMs() / 1000));
        // PR-WIDE ADMISSION BEFORE THE SWEEP.
        //
        // The sweep is not a drive-state mutation, so `claimLease` never gated
        // it — but it is not read-only either: it invokes `resolve-thread.ts`
        // and resolves threads ON GITHUB. Exit 13 was first raised at the
        // leased `bump-round` far below, so a second worktree reached this
        // point, resolved threads belonging to another resolver's round, and
        // only afterwards learned it was not admitted.
        //
        // Checked here instead, before anything leaves the machine. `admit`
        // takes no lease and mutates nothing, so this cannot itself become the
        // second driver it is testing for.
        const admit = await run(tsArgv(ctx.driveStateScript, ["admit", pr]), {
          stderr: "pipe",
          timeoutSec: ctx.helperTimeoutSec,
        });
        if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {
          const code = outOfBand(
            report,
            "DRIVE_HELD_BY_OTHER_WORKTREE",
            "another live working tree is driving this PR — refusing to reconcile threads on its behalf",
          );
          if (admit.stderr) process.stderr.write(admit.stderr);
          await emit(code);
          return code;
        }
        // Any OTHER non-zero is not an admission refusal — it is this probe
        // failing to answer. Skip the sweep rather than run it unadmitted or
        // fail the whole pass: the sweep is idempotent and the next pass entry
        // continues it, which is the same treatment the timeout branch above
        // gives.
        if (admit.code !== 0) {
          if (admit.stderr) process.stderr.write(admit.stderr);
          console.error(
            `drive-status.ts: could not confirm PR-wide admission for #${pr} (drive-state.ts admit exited ${admit.code}) — skipping the reconciliation sweep rather than resolving threads unadmitted`,
          );
        }
        const sweep =
          admit.code !== 0
            ? // Unadmitted-and-unknown: treated exactly like a FAILED sweep
              // below — `sweepSettled` stays false, so a polling invocation
              // re-attempts on the next iteration once the probe can answer,
              // rather than carrying this one failure for the whole window.
              { code: admit.code, stdout: "", stderr: "" }
            : await run(
                tsArgv(
                  join(here, "reconcile-replied-threads.ts"),
                  sweepBotsOnly ? [pr, "--bots-only"] : [pr],
                ),
                {
                  stderr: "inherit",
                  timeoutSec: Math.min(helperTimeoutSec, leftSec),
                },
              );
        if (sweep.stdout !== "") process.stderr.write(sweep.stdout);
        if (sweep.code === 0) {
          sweepReconciled = true;
          sweepSettled = true;
        } else {
          // A FAILED sweep does not settle the question AT ALL: a polling
          // invocation re-attempts it on every iteration rather than carrying
          // one transient failure for the whole `--timeout` window — which is
          // what keeps a `4` returned after that window from meaning "the
          // sweep failed once, an hour ago".
          //
          // Deliberately UNbounded within the invocation, and the bound it
          // replaces was a real bug: capping re-attempts left the loop still
          // polling but no longer trying to fix the thing it was waiting on,
          // which contradicted this skill's own docs and could leave answered
          // threads unresolved after a transient helper failure had already
          // cleared. The natural bound is the
          // poll: one attempt per `--interval`, each deadlined by
          // `$DRIVE_PR_HELPER_TIMEOUT`, for at most `--timeout` — so a durably
          // failing sweep costs one short subprocess per poll on a run that is
          // already anomalous, against the alternative of silently stopping.
          sweepSettled = false;
          sweepRanAndFailed = true;
          console.error(
            `drive-status.ts: the replied-thread reconciliation sweep for #${pr} exited ${sweep.code} — one or more already-answered threads may still be unresolved on GitHub (re-run reconcile-replied-threads.ts to see which)`,
          );
        }
      }
    }

    // RE-READ THE BUDGET AFTER RECONCILIATION, because the block above can
    // have consumed it: the liveness read carries its own `GH_CALL_TIMEOUT`
    // and the sweep is clamped to whatever was left, so an iteration that
    // began with budget can arrive here with none. The loop-top check is a
    // stale answer by this point.
    //
    // Bounded to iterations PAST the first, and that boundary is the same
    // promise as above: the caller is owed one `evaluate()`, so iteration 1
    // proceeds on a spent budget by contract. Every later iteration is owed
    // nothing, so a budget the sweep just exhausted stops the invocation here
    // rather than adding a whole evaluation on top of the overrun.
    //
    // What this deliberately does NOT claim: that `--timeout` bounds the
    // invocation's total wall clock. It cannot, and no check here could make
    // it — the promised first evaluation is unbounded by it by construction,
    // and `evaluate()` is not deadline-aware, so "reserving" budget for it
    // would be a number with nothing reading it. What bounds that evaluation
    // is its own per-call deadlines (`GH_CALL_TIMEOUT`,
    // `$DRIVE_PR_HELPER_TIMEOUT`), which is exactly what SKILL.md § Deadlines
    // says `--timeout` does and does not cover.
    if (iterations > 1 && budgetLeftMs() <= 0) {
      const stop = await degrade(
        `#${pr}'s ${timeout}s budget was spent by the replied-thread reconciliation sweep, so this iteration will not add an evaluation on top of the overrun`,
      );
      if (stop !== null) return stop;
      continue;
    }

    const code = await evaluate(ctx, report);

    // RETRACT a skip the evaluation just contradicted. The liveness read said
    // the PR was finished, so the sweep was skipped as pointless; the
    // evaluation is a later, independent snapshot, and anything other than
    // PR_NOT_OPEN means it disagrees — the PR was REOPENED in between, or the
    // read was stale. The skip's whole justification is gone, so it is
    // withdrawn rather than merely denied the licence to certify a stopper:
    // otherwise a reopened PR could be handed a ROUND_READY that never swept,
    // which contradicts this gate's own contract that reconciliation happens
    // before any verdict at all.
    //
    // BOUNDED BY A BUDGET, not by a latch, because this branch `continue`s
    // past the `switch` below and every budget in this loop lives inside it.
    // Earlier cuts of that bound were wrong in opposite directions, and they
    // are worth keeping written down:
    //
    //   A bare flag was no bound at all — it cleared here, but the next
    //   iteration's liveness read set it again, so an `evaluate()` that kept
    //   returning INDETERMINATE looped forever, `--once` included.
    //
    //   A one-shot LATCH bounded the loop but reopened the hole the branch
    //   exists to close: after the first retraction, a second CLOSED probe
    //   followed by an open evaluation was let through, and ROUND_READY was
    //   returned unswept.
    //
    // So the disagreement is retried on a budget and, when that runs out,
    // becomes INDETERMINATE — never an unswept verdict. `degrade()` is the
    // right shape for the exhausted case: it re-arms the probe, charges
    // `queryErrors`, and reports the retry class rather than a verdict.
    //
    // `code !== 1` stays, and is semantic rather than a bound: the premise is
    // that the evaluation DISAGREES, and an unreadable evaluation does not
    // disagree — it says nothing. Falling through hands it to `case 1`, which
    // is bounded and is the right answer for an unreadable read.
    //
    // Under `--once` it does not retract at all, it degrades on the first
    // disagreement. Retracting means re-running `evaluate()`, and `--once` is a
    // promise to evaluate once — a promise this branch was quietly breaking,
    // since it is the only path that loops without sleeping. Deferring is the
    // same answer this gate gives everywhere else for `--once`: the caller
    // comes back, and its next pass entry sweeps.
    if (skippedAsFinished && code !== 5 && code !== 1) {
      skippedAsFinished = false;
      if (once || skipRetractions >= MAX_QUERY_ERRORS) {
        const stop = await degrade(
          `#${pr}'s liveness read keeps reporting it finished while the evaluation keeps reporting ${report.state} — the two disagree persistently, so this invocation cannot reconcile before judging and will not judge unreconciled`,
        );
        if (stop !== null) return stop;
        continue;
      }
      skipRetractions += 1;
      sweepSettled = sweepSuppressed;
      console.error(
        `drive-status.ts: #${pr} read as finished before the sweep but evaluates to ${report.state} — retracting the skip and reconciling before judging this round`,
      );
      continue;
    }

    // A verdict that ENDS THE DRIVE may not be reported while reconciliation
    // is outstanding: after one of these no later pass is promised, so a
    // thread the sweep failed to resolve stays open with nothing left to retry
    // it, indefinitely. Degrading to the
    // retry class re-attempts the sweep on the next iteration, and bounded
    // exhaustion reports INDETERMINATE, which `drive.ts` propagates as a
    // stop-and-look rather than looping on.
    //
    // The set is derived ONCE, from a single criterion — a code that ASSERTS
    // THE DRIVE IS OVER (so no caller is expected to come back), that could be
    // hiding an unreconciled thread, and that a retry could plausibly change
    // — rather than enumerated and then
    // extended as each omission is reported. That is not a stylistic
    // preference: built the other way this guard shipped a hole per round (7
    // missing, then `--no-reconcile` exempt, then `--no-count` exempt), each
    // argued on its own merits and each wrong for the same structural reason.
    // Every exclusion below is stated against that same criterion, so a future
    // code is classified by reading it rather than by adding a case.
    //
    // UNSUPPORTED_CLI (2) was the last code to be excluded and is now IN the
    // set, which is worth recording because its exclusion looked sound twice.
    // The argument was "a retry cannot clear an unsupported `gh`, and the
    // sweep cannot run under that `gh` either, so gating buys no
    // reconciliation" — the second clause being the load-bearing one, and it
    // is simply false: this suite's own `reconciles ahead of the EARLIEST
    // return — UNSUPPORTED_CLI` test exists because the sweep DOES run, and
    // can succeed, before exit 2 is reached. A `gh` too old for
    // `--json mergeable` can still serve the sweep's GraphQL calls.
    //
    // An earlier cut of this fix kept the exclusion and made it conditional on
    // a `sweepSkippedForBudget` flag, which covered the sweep being SKIPPED and
    // left the sweep having RUN AND FAILED — the same hole, other branch.
    // Membership needs no flag: a successful sweep sets `sweepReconciled`, so
    // exit 2 still returns with the one message naming the actual fix in every
    // case where `gh` can talk to GitHub at all. Only a genuinely unreconciled
    // pass degrades, which is the criterion above applied without an exception.
    //
    // CONVERGED (3) STAYS out of this set, and that took a false start to
    // learn: a first cut of this fix reasoned "3 needs zero unresolved
    // threads, so a failed sweep cannot be hiding one behind it" is true of
    // the GitHub thread but not of this script's own `held` bookkeeping (see
    // the next paragraph) and folded 3 in here, blanket, the same way 2
    // joined above. That broke `announce-merge-ready.ts`: its own `--no-count`
    // re-read (SKILL.md §§ 3 and 6) exists SPECIFICALLY to check CONVERGED
    // without spending a round, and CONVERGED is the ONLY verdict that caller
    // ever acts on. `--no-count` sets `sweepSuppressed` exactly like
    // `--no-reconcile` does, so `sweepReconciled` can never be true on that
    // call — folding 3 into this blanket set made CONVERGED permanently
    // unreachable through the one path built to reach it without a sweep. The
    // suite's own `announce-merge-ready.ts` describe block is what caught it:
    // most of it failed, each test expecting a real exit code and getting `1`.
    //
    // The real gap CONVERGED has is narrower than "any failed sweep", and the
    // guard below covers PART of it without the `--no-count` cost above.
    // Resolving a thread that carries a superseding merit reply also clears a
    // stale prior `held` entry for it (the release-held cleanup above), and
    // that cleanup can fail AFTER the resolve already succeeded:
    // `mutation.code === 0` counts the thread as resolved regardless of what
    // the cleanup that follows does, so a failed `held` read or
    // `release-held` call still exits the sweep nonzero. `evaluate()` then
    // sees zero unresolved threads — the resolve genuinely landed on GitHub —
    // and would return CONVERGED, but the held entry survives, and no LATER
    // sweep will ever revisit it: the thread it keys on has already left the
    // unresolved listing this script enumerates, so nothing calls
    // `release-held` for it again. Unlike the blanket set above, this one has
    // to distinguish "suppressed" from "ran and failed" — a
    // `--no-count`/`--no-reconcile` invocation must stay ABLE to certify
    // CONVERGED, so only a sweep that genuinely ran withholds it. See the
    // dedicated guard below rather than `UNRECONCILED_STOPPERS` membership.
    //
    // WHAT THIS ACTUALLY CLOSES, stated precisely rather than as "covered": for
    // a SINGLE, `--once` invocation (the interactive gate, SKILL.md § 1) it is
    // the whole fix — that pass reports INDETERMINATE, naming the stale key on
    // stderr, instead of silently certifying over it. For a POLLING invocation
    // (`drive.ts`'s own call, which never passes `--once`), `degrade` re-arms
    // and retries the sweep on the next `--interval`; by then the thread has
    // already left the unresolved listing this script enumerates, the sweep
    // exits 0 cleanly with nothing left to do, and CONVERGED is certified one
    // interval later with the stale entry still unrevisited — the guard only
    // delays that certification, it does not make the cleanup durable. Closing
    // the cross-invocation case needs the fix to live where the leak actually
    // is (a retryable `release-held`, or a dedicated pass over `held` entries
    // whose thread has since resolved) rather than in this gate, which can only
    // ever refuse to CERTIFY, never resolve, anything on this side.
    //
    //   5  PR_NOT_OPEN — nothing to reconcile on a finished PR.
    //   1  INDETERMINATE — already this branch's own output.
    //   4  NOT_SETTLED — the WAITING class. It is the one code here that does
    //      not assert the drive is over: it says the round cannot be judged
    //      YET, and every caller answers it by coming back — `drive.ts` after
    //      its poll window, the interactive gate (SKILL.md § 1) on the next
    //      pass. Either way the next invocation's pass entry sweeps, which is
    //      the re-arm this criterion asks for.
    //
    //      Note the retry story differs by mode, and an earlier version of this
    //      comment claimed the polling one for both: without `--once` the sweep
    //      is re-attempted on every poll, so a 4 returned after the window has
    //      been retried throughout; WITH `--once` there is a single iteration
    //      and no in-invocation retry at all. That does not change the
    //      classification — the re-arm comes from the caller in both modes —
    //      but the rationale must not rest on a retry that only one of them
    //      performs.
    //
    // CONVERGED's own gate, separate from set membership for the reason given
    // above: `!sweepReconciled` alone would ALSO be true on every SUPPRESSED
    // invocation, and `announce-merge-ready.ts`'s `--no-count` re-read has to
    // stay able to certify CONVERGED through exactly that state.
    // `!sweepReconciled && !sweepSuppressed` is not the fix either — both
    // budget-skip paths above (the loop-top spent check, and "the liveness read
    // just spent the budget") leave `sweepSuppressed` false too, since neither
    // flag was passed, so that predicate is also true when the sweep merely
    // never got a turn this iteration — which produced a false INDETERMINATE on
    // a genuinely converged PR whose sweep was skipped, not run and failed.
    // `sweepRanAndFailed` is the narrower fact: set ONLY where the sweep
    // subprocess actually spawned and exited nonzero, never by a skip.
    const convergedUnswept =
      code === 3 && sweepRanAndFailed && !sweepReconciled;
    if (
      (!sweepReconciled && UNRECONCILED_STOPPERS.has(code)) ||
      convergedUnswept
    ) {
      const ending = report.state;
      const stop = await degrade(
        sweepSuppressed
          ? `#${pr} evaluates to ${ending}, which ends the drive — but ${noReconcile ? "--no-reconcile" : "--no-count"} suppressed the replied-thread reconciliation sweep, so this invocation cannot certify that verdict. Re-run as an ordinary counting pass.`
          : convergedUnswept
            ? `#${pr} evaluates to CONVERGED, but the replied-thread reconciliation sweep just ran and exited nonzero — a resolved thread's own held-state cleanup may have failed, leaving a stale entry that will not surface again once this thread leaves the unresolved listing. Run 'drive-state.ts held ${pr}' to check for one before re-running.`
            : `#${pr} evaluates to ${ending}, which ends the drive — but this pass did not complete the replied-thread reconciliation sweep, so an already-answered thread could be left unresolved with nothing to retry it`,
      );
      if (stop !== null) return stop;
      continue;
    }

    switch (code) {
      case 1: {
        // Never let an unreadable state decay into a settled one. Retry a
        // bounded number of times, then say so — guessing here is how a round
        // gets abandoned on an auth blip.
        //
        // Bounded by the CLOCK as well as by the error count, through the same
        // `intervalFits()` every other waiting site uses. This branch consulted
        // neither `deadline` nor anything derived from it, so it slept a full
        // interval past the advertised timeout and handed the next iteration a
        // spent budget to spawn a reconciliation sweep with.
        queryErrors += 1;
        if (once || queryErrors >= MAX_QUERY_ERRORS || !intervalFits()) {
          await emit(1);
          return 1;
        }
        console.error(
          `${report.reason} (attempt ${queryErrors}/${MAX_QUERY_ERRORS}); retrying`,
        );
        await sleep(interval);
        continue;
      }
      case 4: {
        // Not settled yet. These are the states that BECOME something else
        // with time — head lag resolves, the reviewer finishes, the marker
        // catches up.
        queryErrors = 0;
        if (once) {
          await emit(4);
          return 4;
        }
        // The budget is spent when the NEXT sleep no longer fits, not when the
        // clock has already passed the deadline. `Date.now() >= deadline` let
        // a full `--interval` be slept on top of whatever the iteration had
        // already spent, so `--timeout 30 --interval 30` returned at ~50s when
        // a sweep took the first 20 — and
        // then handed the following iteration a spent budget. `intervalFits()`
        // is the shared predicate — `degrade()` and `case 1` stop on it too —
        // so no waiting site can answer this differently from another.
        if (!intervalFits()) {
          report.reason = `${report.reason} (gave up after ${timeout}s)`;
          await emit(4);
          return 4;
        }
        console.error(
          `${report.state}: ${report.reason}; waiting ${interval}s`,
        );
        await sleep(interval);
        continue;
      }
      case 0: {
        // A round is a distinct push, not a distinct invocation: retrying the
        // same pass after an agent failure must not count twice, or a round
        // budget measures driver retries instead of reviewer rounds.
        //
        // A FAILED persist is indeterminate, never a green light: returning
        // ROUND_READY having recorded nothing means every restart grants
        // another full `--max-rounds` on a counter that never advanced — a
        // bounded loop that is bounded only within one process. An unwritable
        // state dir is a real fault; say so and stop.
        if (!noCount) {
          const bump = await run(
            tsArgv(ctx.driveStateScript, [
              "bump-round",
              pr,
              "--head",
              report.apiHead,
            ]),
            {
              stdout: "ignore",
              // CAPTURED, not discarded: the lease refusal below is only
              // actionable if the child's own diagnostic reaches the caller.
              stderr: "pipe",
              timeoutSec: ctx.helperTimeoutSec,
            },
          );
          // Exit 11 is not a persistence fault, and flattening it into one
          // costs exactly what the session lease exists to provide. This is
          // the DOCUMENTED entry point for a pass (SKILL.md § 1), so a second
          // interactive session in one tree meets the lease HERE first — and
          // a generic INDETERMINATE tells it to go looking for an unwritable
          // state dir instead of naming the live holder's pid, its liveness check, and
          // `clear-lease`. Propagate the code and the child's own diagnostic
          // verbatim: the refusal has to reach the human who can act on it.
          if (bump.code === SESSION_LEASE_HELD_EXIT) {
            const code = outOfBand(
              report,
              "SESSION_LEASE_HELD",
              "another live session in this working tree holds the drive lease for this PR",
            );
            if (bump.stderr) process.stderr.write(bump.stderr);
            await emit(code);
            return code;
          }
          // The cross-TREE refusal, kept distinct from 11 all the
          // way out to the caller for the reason the code exists: a driver
          // reading `SESSION_LEASE_HELD` goes looking in its own tree for a
          // session that is not there.
          if (bump.code === DRIVE_HELD_ELSEWHERE_EXIT) {
            const code = outOfBand(
              report,
              "DRIVE_HELD_BY_OTHER_WORKTREE",
              "another live working tree is driving this PR — refusing to be the second resolver",
            );
            if (bump.stderr) process.stderr.write(bump.stderr);
            await emit(code);
            return code;
          }
          if (bump.code !== 0) {
            report.state = "INDETERMINATE";
            report.reason = `could not record the round for ${report.apiHead} — the durable round budget would not survive a restart`;
            if (bump.stderr) process.stderr.write(bump.stderr);
            await emit(1);
            return 1;
          }
        }
        // This round's finding anchors, filed against the round the bump above
        // just counted. Best-effort and advisory; see the function.
        await recordRoundPaths();
        // `--bump-attempt`: record this PASS before `emit` computes
        // `reflectDue`, so the field it reports is never one pass stale. This
        // is what the flag exists for — see its own doc comment above for the
        // failure it closes.
        //
        // Skipped when `$DRIVE_PR_TARGET` is set: that env var is only ever
        // present when `drive.ts` spawned this process as one round's pass, and
        // `drive.ts` already recorded this exact pass's attempt itself (its own
        // separate `bump-attempt` call, before spawning the pass) — bumping
        // again here would double-count every real pass under the unattended
        // driver, firing `reflectDue` after 2 passes instead of more than 3 and
        // hitting `--max-rounds` around pass 5 instead of 10. By the time this
        // line runs, `$DRIVE_PR_TARGET` has already been checked equal to `pr`
        // above (or this process exited) — no further comparison needed.
        // `reflectDue` still reads correctly with the bump skipped: the durable
        // counter already reflects drive.ts's own prior bump for this round.
        if (bumpAttempt && !process.env.DRIVE_PR_TARGET) {
          const bumpA = await run(
            tsArgv(ctx.driveStateScript, [
              "bump-attempt",
              pr,
              "--head",
              report.apiHead,
            ]),
            {
              stdout: "ignore",
              stderr: "pipe",
              timeoutSec: ctx.helperTimeoutSec,
            },
          );
          // Same exit-11 branch as `bump-round` above, and NOT redundant with
          // it: `bump-round` is skipped under `--no-count`, which the parser
          // accepts alongside `--bump-attempt`. In that combination this is
          // the FIRST leased call of the process, so it is where a second
          // interactive session in one tree meets the lease — and flattening
          // its 11 into INDETERMINATE would discard the holder's pid, its liveness check
          // and `clear-lease` on exactly the path that has no earlier call to
          // have surfaced them (verified: `bump-attempt` is in
          // `drive-state.ts`'s LEASED_COMMANDS and returns 11 unaided).
          if (bumpA.code === SESSION_LEASE_HELD_EXIT) {
            const code = outOfBand(
              report,
              "SESSION_LEASE_HELD",
              "another live session in this working tree holds the drive lease for this PR",
            );
            if (bumpA.stderr) process.stderr.write(bumpA.stderr);
            await emit(code);
            return code;
          }
          // Same distinction as the `bump-round` branch above, on the path
          // where `--no-count` makes THIS the first leased call of the process
          // and so the only one that can meet either gate.
          if (bumpA.code === DRIVE_HELD_ELSEWHERE_EXIT) {
            const code = outOfBand(
              report,
              "DRIVE_HELD_BY_OTHER_WORKTREE",
              "another live working tree is driving this PR — refusing to be the second resolver",
            );
            if (bumpA.stderr) process.stderr.write(bumpA.stderr);
            await emit(code);
            return code;
          }
          if (bumpA.code !== 0) {
            report.state = "INDETERMINATE";
            report.reason = `could not record this pass attempt for ${report.apiHead} — the durable attempt budget would not survive a restart`;
            // Forwarded for the same reason the `bump-round` branch above
            // forwards its own: the summary names the decision, the child's
            // stderr names the cause.
            if (bumpA.stderr) process.stderr.write(bumpA.stderr);
            await emit(1);
            return 1;
          }
        }
        await emit(0);
        return 0;
      }
      default: {
        await emit(code);
        return code;
      }
    }
  }
}

runMain("drive-status.ts", main);
