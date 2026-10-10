#!/usr/bin/env bun
/**
 * Push the current branch, but only after re-confirming — at this instant —
 * that the PR is still open.
 *
 * `drive.ts` checks liveness before handing a round to the agent. That check
 * cannot cover the push, because the pass between them triages, fixes, runs
 * the gates and commits: minutes, sometimes many. A PR that merges anywhere in
 * that window leaves the pass pushing onto a branch nothing will ever merge,
 * silently, and the round's work is lost with no error anywhere. The liveness
 * check has to happen where the irreversible act is, not where the round began
 * — so it happens here, and SKILL.md § 6 routes every push through this script
 * rather than `git push`.
 *
 * Usage: guarded-push.ts [PR] [--expect-head SHA] [-- <extra git push args>]
 *
 * Extra arguments are ALLOWLISTED, not forwarded verbatim — see the parser.
 * `--dry-run` returns on the push command's own status: it updates nothing, so
 * the post-push head confirmation has nothing to confirm and is skipped —
 * and, for the identical reason, the session/tree lease fences below are
 * skipped too: a rehearsal that mutates nothing remote has nothing for them
 * to guard.
 *
 * `--expect-head` is optional and closes a race this script cannot close on
 * its own: this process resolves its own `localSha` fresh, in a NEW
 * subprocess, independently of whatever HEAD a caller read before invoking
 * it — a commit landing in the shared worktree between the caller's own
 * read and this call would otherwise be pushed even though nothing validated
 * it (docomply-review, a reference-implementation pull request round 5). A caller that already read a
 * validated SHA (`finish-round.ts`'s own `report.head`) should pass it here;
 * a mismatch refuses (exit 2) before any fence or lock is acquired.
 *
 * $DRIVE_PR_PUSH_TIMEOUT bounds the push itself (default 3600s). It covers the
 * pre-push hook too, so it is measured in tens of minutes — see the call site.
 *
 * Exit codes:
 *   0  pushed
 *   5  the PR is no longer open — nothing was pushed
 *   1  the push failed, or the PR state could not be read (never pushes on an
 *      unreadable state: an auth blip must not be read as "still open"), or
 *      this tree's TREE lease exists but could not be read as one
 *   2  usage error (including a refused push destination or extra argument)
 *   11 this working tree's TREE lease is held by another live
 *      session, or this PR's per-PR lease is, or this PR's own
 *      remote-mutation lock could not be acquired within its
 *      bound — another worktree's push or POST is still in flight — the
 *      identical session-lease contract every other mutating or posting
 *      script in this skill carries; see `lib/state/lease.ts`'s
 *      `assertTreeMutationAllowed` and `assertRemoteMutationAllowed`
 *   17 a `hold-push` mailbox directive (lib/state/mailbox.ts) is active —
 *      a live session in this tree explicitly asked for pushes to wait.
 *      Nothing was pushed. Not one of drive.ts's shared terminal codes:
 *      `references/terminal-states.md` currently runs through `16`
 *      (`QUOTA_PARKED`) — this was originally allocated `15`
 *      under the stale belief that table topped out at `14`, directly
 *      colliding with the ALREADY-assigned `PASS_DEADLINE` and making an
 *      exit `15` from this script ambiguous with one from `drive.ts`
 *      itself (docomply-review / chatgpt-codex-connector, a reference-implementation pull request
 *      round 15). `17` is the first code past that table's current top;
 *      this is a LOCAL, recoverable refusal a mailbox `resume
 *      --target hold-push` clears, not a drive-ending state —
 *      `finish-round.ts` does not special-case it and reports it through
 *      the generic PUSH_FAILED path, which is the right fallback for a
 *      refusal this benign. Raised on either side of the push: before it
 *      starts, and — when the pre-push hook chain aborted it because a hold
 *      landed DURING validation (`push-hold-recheck.ts`, the chain's last
 *      step) — afterwards, mapped from the failed push
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, isDigits, isGitSha, runMain, sleep } from "./lib/cli.ts";
import { ghCall, git, readTimeoutEnv, resolvePr } from "./lib/proc.ts";
import { repoOfUrl } from "./lib/repo-url.ts";
import {
  assertRemoteMutationAllowed,
  assertTreeMutationAllowed,
  resolveFenceContext,
} from "./lib/state/lease.ts";
import { lockHeartbeatMs } from "./lib/state/lock.ts";
import {
  holdAbortUnmarkedSentinel,
  PUSH_HELD_EXIT,
  readPushHoldUnderLock,
  resolveMailboxDir,
} from "./lib/state/mailbox.ts";

// The extra-argument channel forwards to `git push`, so it is a channel for
// every option `git push` has — including the classes this script may not
// expose:
//
//   hook bypass   `--no-verify` skips the pre-push hook (git's own wording).
//                 SKILL.md § 6 makes a successful guarded push the evidence on
//                 which held `accepted` threads are resolved and `accepted`
//                 summary answers posted, so removing the gates turns "the fix
//                 landed and passed" into "the fix landed" while every
//                 downstream step still trusts it.
//   ref-set       `--tags` / `--follow-tags` write refs the explicit branch
//                 refspec below does not name, so this wrapper would update
//                 unrelated refs irreversibly while reporting only that the PR
//                 branch moved.
//
// An ALLOWLIST, not a denylist of those spellings. Git accepts unambiguous
// abbreviations — `--no-veri` reaches normal destination resolution — so a
// denylist has to enumerate every prefix of every dangerous option and stays
// wrong the moment git adds one. Naming what MAY pass inverts the default to
// refuse, which is the only version that is right by construction. The set is
// small on purpose: an option that belongs here is one a review-fix push
// genuinely needs, and adding one is a deliberate edit, not a forwarding
// accident.
function allowlisted(arg: string): boolean {
  return (
    arg === "--force-with-lease" ||
    arg.startsWith("--force-with-lease=") ||
    arg === "--atomic" ||
    arg === "--quiet" ||
    arg === "-q" ||
    arg === "--verbose" ||
    arg === "-v" ||
    arg === "--dry-run" ||
    arg === "--porcelain" ||
    arg === "--verify"
  );
}

/**
 * `env` with the `push-hold-recheck.ts` arming variables removed, for a push
 * that must not be armed (`--dry-run`): `proc.ts` defaults a child's
 * environment to `process.env`, so a caller that already exports them would
 * otherwise arm the rehearsal.
 */
function withoutHoldRecheckEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const {
    DRIVE_PR_HOLD_RECHECK_PR: _pr,
    DRIVE_PR_MAILBOX_DIR: _dir,
    DRIVE_PR_HOLD_RECHECK_ABORT_FILE: _abort,
    DRIVE_PR_HOLD_RECHECK_NONCE: _nonce,
    ...rest
  } = env;
  return rest;
}

async function main(): Promise<number> {
  let pr = "";
  let expectHead = "";
  let sawExpectHead = false;
  const extra: string[] = [];
  let sawDdash = false;
  const argv = process.argv.slice(2);
  const take = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) fail(2, `${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (sawDdash) {
      if (!allowlisted(a)) {
        fail(
          2,
          `guarded-push: refusing to forward '${a}' to git push.`,
          "This channel accepts only options that cannot weaken the guarantee a",
          "guarded push is supposed to carry — the pre-push gates ran, and exactly",
          "the PR's head branch moved. Anything that skips a hook (--no-verify, and",
          "every abbreviation of it) or widens the ref set (--tags, --follow-tags)",
          "breaks one of those, so the list is an allowlist rather than a denylist.",
          "Allowed: --force-with-lease[=...] --atomic --quiet/-q --verbose/-v",
          "         --dry-run --porcelain --verify",
          "If you need something else, push by hand and own it explicitly.",
        );
      }
      extra.push(a);
      continue;
    }
    if (a === "--") {
      sawDdash = true;
      continue;
    }
    if (a === "--expect-head") {
      expectHead = take(a, i++);
      sawExpectHead = true;
      continue;
    }
    if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else pr = a;
  }

  // `take()` only checks a next argv element EXISTS, not that it is a usable
  // SHA — so `--expect-head ''` (an empty-string argument, not an omitted
  // flag) parsed as `expectHead = ''`, indistinguishable from the flag never
  // being passed at all by the string alone, and the check below
  // (`expectHead !== ''`) then silently disabled the whole check — the
  // opposite of what passing the flag at all means. `sawExpectHead` is what
  // tells the two apart: a caller that means "no check" omits the flag
  // entirely; a caller that passes it with a malformed value (an empty or
  // interpolated-away variable, the most likely real cause) almost certainly
  // has a bug worth surfacing immediately, not a request to skip the race
  // this flag exists to close (chatgpt-codex-connector, a reference-implementation pull request round 9).
  if (sawExpectHead && !isGitSha(expectHead)) {
    fail(
      2,
      `guarded-push: --expect-head '${expectHead}' is not a full 40-character git SHA.`,
      "Omit the flag entirely to skip the check; pass a real SHA to use it.",
    );
  }

  // $DRIVE_PR_TARGET is the driver's out-of-band statement of the PR under
  // drive; prefer it over a branch lookup so a pass in a mis-pointed worktree
  // cannot push against a different PR's liveness.
  //
  // An explicit positional PR does NOT quietly outrank it. Under a drive for
  // #999, a mistargeted `guarded-push.ts 1234` would otherwise check #1234's
  // liveness and then push the local HEAD onto #1234's head branch — every
  // guard in this script satisfied, and the wrong pull request advanced
  // irreversibly. The two channels disagreeing is an operator error, not a
  // precedence question, so it is refused.
  const target = process.env.DRIVE_PR_TARGET ?? "";
  // Canonicalized (leading zeros stripped) before comparing, not compared
  // raw: `DRIVE_PR_TARGET=0999` and an explicit `guarded-push.ts 999` name
  // the SAME PR, but a raw string comparison here would refuse them as a
  // mismatch — the identical class of bug the later `BigInt(pr).toString()`
  // canonicalization already exists to prevent for the mailbox comparison,
  // just not yet applied at this earlier check (coderabbitai, PR #4446
  // round 16). Non-digit input is left as-is: it fails validation just
  // below regardless of what this comparison decides.
  const canonPrArg = (s: string): string =>
    isDigits(s) ? BigInt(s).toString() : s;
  if (target !== "" && pr !== "" && canonPrArg(pr) !== canonPrArg(target)) {
    fail(
      2,
      `guarded-push: PR #${pr} was passed explicitly but the drive target is #${target}.`,
      "Refusing to guess which one you meant: pushing to the wrong PR's head branch",
      "cannot be undone. Drop the argument, or unset DRIVE_PR_TARGET.",
    );
  }
  if (pr === "") pr = target;
  pr = await resolvePr(pr);
  if (!isDigits(pr)) {
    fail(2, `guarded-push: could not resolve a numeric PR (got '${pr}')`);
  }
  // Canonicalized, not just validated as digits — the mailbox's own PR
  // comparisons are plain string equality, so an unstripped leading zero
  // here would make `isPushHeld` compare against a `pr` a
  // correctly-canonical `mailbox.ts send 999 ...` never wrote, silently
  // admitting a push a live hold-push directive should have blocked
  // (chatgpt-codex-connector, a reference-implementation pull request round 8 — same class as
  // mailbox.ts's own `resolvePrArg`).
  pr = BigInt(pr).toString();

  // Materialise the query, then split it: an unreadable read must stay exit 1
  // (never fall through to the state check and misreport PR_NOT_OPEN — the
  // driver treats 5 as terminal, and an auth blip is not a merged PR).
  const view = await ghCall(
    [
      "pr",
      "view",
      pr,
      "--json",
      "state,headRefName,headRepositoryOwner,headRepository",
    ],
    { stderr: "ignore" },
  );
  let parsed: Record<string, unknown> | null = null;
  if (view.code === 0) {
    try {
      parsed = JSON.parse(view.stdout) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (parsed === null) {
    fail(
      1,
      `guarded-push: cannot read PR #${pr} — refusing to push on an unknown state`,
    );
  }
  const state = String(parsed.state ?? "");
  const headRef = String(parsed.headRefName ?? "");
  const headOwner = String(
    (parsed.headRepositoryOwner as Record<string, unknown> | null)?.login ??
      "?",
  );
  const headName = String(
    (parsed.headRepository as Record<string, unknown> | null)?.name ?? "?",
  );
  const headRepo = `${headOwner}/${headName}`;

  if (state !== "OPEN") {
    fail(
      5,
      `guarded-push: PR #${pr} is ${state} — NOT pushing.`,
      "The branch is orphaned; this round’s commits stay local so the work is",
      "visible rather than silently landing somewhere nothing will merge.",
    );
  }

  if (headRef === "") {
    fail(
      1,
      `guarded-push: PR #${pr} reported no head branch — refusing to guess a push target`,
    );
  }

  // A PR's head can live in a FORK. `origin` is then the wrong remote
  // entirely: the push either fails, or — worse — updates a same-named branch
  // in the base repository, which the post-push head check catches only after
  // an irreversible write to someone else's branch. There is no safe guess
  // here, so refuse and say which repository the commits actually belong in.
  //
  // The comparison is against the remote THE PUSH ACTUALLY WRITES TO, resolved
  // from git, not against whatever `gh repo view` calls "this repository".
  // Those are not the same thing: `gh` resolves through `$GH_REPO`, `gh repo
  // set-default` and its own remote ordering, so a clone whose `origin` points
  // somewhere else passes a `gh`-derived comparison and then pushes the PR's
  // branch name into an unrelated repository — with the post-push head check
  // noticing only after the irreversible write. `git remote get-url --push` is
  // the one answer that IS the push destination: it honours
  // `remote.origin.pushurl` and expands `url.*.pushInsteadOf` / `insteadOf`,
  // i.e. every rewrite git will apply.
  //
  // We still push by the NAME `origin` rather than by the resolved URL,
  // because a URL push updates no remote-tracking ref —
  // `refs/remotes/origin/<branch>` would silently stop tracking the branch
  // this driver just advanced, which is the phantom-"N commits ahead" failure
  // .claude/rules/git-workflow.md documents.
  //
  // Both identities must be READ before the comparison means anything.
  // Defaulting either to empty and skipping the comparison turns a transient
  // failure into permission to push — precisely the irreversible
  // wrong-repository write this guard exists to prevent, reached by the one
  // path where nobody is watching.
  //
  // EVERY configured push URL is resolved and checked, not just the first.
  // `remote.origin.pushurl` is multi-valued, and `git push origin` writes to
  // all of them — so validating one leaves a second, unrelated repository
  // advanced irreversibly by a push this guard called safe. `--all` is git's
  // own answer to "which destinations is that".
  const urlsRes = await git(
    ["remote", "get-url", "--push", "--all", "origin"],
    {
      stderr: "ignore",
    },
  );
  const pushUrls =
    urlsRes.code === 0
      ? urlsRes.stdout.split("\n").filter((u) => u !== "")
      : [];
  if (pushUrls.length === 0) {
    fail(
      1,
      "guarded-push: no push URL for the remote 'origin' — refusing to push.",
      "Without it there is no way to tell which repository this push would write",
      "to, and the wrong one cannot be undone.",
    );
  }
  if (headRepo.includes("?")) {
    fail(
      1,
      `guarded-push: PR #${pr} reported no head repository — refusing to push.`,
      "The head repository is what decides whether 'origin' is the right remote.",
    );
  }
  // Every destination must be the PR's head repository. One mismatch anywhere
  // in the list refuses the whole push: `git push` is all-or-nothing across
  // push URLs from this script's point of view, so "most of them are right" is
  // not a state it can act on.
  for (const pushUrl of pushUrls) {
    const pushRepo = repoOfUrl(pushUrl);
    if (pushRepo === "") {
      fail(
        1,
        "guarded-push: cannot parse an owner/name out of origin's push URL",
        `(${pushUrl}) — refusing to push to a destination this script cannot name.`,
      );
    }
    if (pushRepo !== headRepo) {
      fail(
        2,
        `guarded-push: PR #${pr}'s head is in ${headRepo}, but 'origin' pushes to`,
        `${pushRepo} (${pushUrl}).`,
        `Pushing here would write the branch name '${headRef}' into a repository that`,
        "is not the pull request's head — a fork PR, a mis-pointed 'origin', an extra",
        "remote.origin.pushurl, or a gh resolution ($GH_REPO / gh repo set-default)",
        "that disagrees with git.",
        `Push to ${headRepo}:${headRef} yourself, or drive from a clone of it.`,
      );
    }
  }

  const headRes = await git(["rev-parse", "HEAD"], { stderr: "inherit" });
  if (headRes.code !== 0) return 1;
  const localSha = headRes.stdout.trim();

  // `--expect-head` closes the OUTER race, not the inner one already fixed
  // below: this process's own `localSha` above is resolved fresh, in a NEW
  // subprocess, independently of whatever HEAD the caller (finish-round.ts)
  // read before invoking this script at all — a commit landing in the shared
  // worktree in the gap between the caller's own read and this call still
  // slips through an unpinned invocation (docomply-review, a reference-implementation pull request round 5).
  // Checked here, before any fence or lock is acquired, so a mismatch costs
  // nothing beyond the two `rev-parse` calls already spent — cheaper than
  // discovering it only after the push, the way the OLD literal-`HEAD`
  // refspec bug did.
  if (expectHead !== "" && expectHead !== localSha) {
    fail(
      2,
      `guarded-push: local HEAD is ${localSha}, but the caller's own preflight`,
      `resolved ${expectHead} — refusing to push a commit the caller never`,
      "validated. Something committed in this worktree between the caller's",
      "read and this call. Re-run against a settled tree once nothing else is",
      "writing to it.",
    );
  }

  // Push an EXPLICIT refspec at the PR's own head branch. A bare `git push`
  // obeys whatever the worktree's upstream, `push.default` and configured
  // refspecs say, so it can update a different existing branch — or several —
  // while the liveness check above happily inspected the intended PR.
  // Detecting that afterwards is too late; an already-successful wrong-ref
  // update cannot be undone. Naming the target removes the ambiguity instead
  // of policing it.
  //
  // The SOURCE side names `localSha`, not the literal `HEAD` token
  // (chatgpt-codex-connector, a reference-implementation pull request round 4). Everything between here and
  // the actual `git push` call below — the fence checks, the lock waits, the
  // heartbeat setup — takes real time in a worktree this skill does not own
  // exclusively, so a literal `HEAD:refs/heads/${headRef}` refspec would let
  // git re-resolve `HEAD` at push time and push whatever a concurrent commit
  // left there, landing a commit none of this process's own preflight
  // checks — nor the caller's pre-push validation — ever ran against.
  // `localSha` is a resolved object reference: pushing it names an exact,
  // already-existing commit regardless of what the worktree's HEAD does
  // afterward, closing the window rather than merely detecting it later.
  //
  // Bounded, unlike every other `git` call in this skill: this is the only one
  // that talks to a remote, so it is the only one that can be accepted and
  // never complete — mode 13 in references/terminal-states.md, and the whole
  // reason `lib/proc.ts` deadlines `gh`. An unattended driver otherwise waits
  // on it forever, past every advertised deadline (docomply-review, a reference-implementation pull request
  // round 1).
  //
  // The default is an HOUR rather than gh's thirty seconds because a
  // legitimate push here is not a network round trip: it runs the pre-push
  // hook, whose heavy phase waits on a machine-wide mutex for up to
  // $DOCOMPLY_TEST_LOCK_TIMEOUT (30m by default, CLAUDE.md §
  // Change-Proportional Validation) and only then runs the build and test
  // suites. A deadline tight enough to feel prompt would kill the gates this
  // push exists to run — and a killed gate reads downstream as "the fix landed
  // and passed", the exact confusion the allowlist above refuses `--no-verify`
  // to prevent. It bounds the hang; it does not police the duration.
  const pushTimeout = readTimeoutEnv("DRIVE_PR_PUSH_TIMEOUT", 3600);
  if (!pushTimeout.ok) {
    fail(
      2,
      "guarded-push: DRIVE_PR_PUSH_TIMEOUT must be a positive whole number of",
      `seconds (got '${pushTimeout.raw}'). It bounds the push INCLUDING the`,
      "pre-push hook, so it is measured in tens of minutes, not seconds.",
    );
  }
  // The last check before the one act in this whole skill that
  // truly cannot be undone. `guarded-push.ts` never called into ANY session
  // fence until now: an orphaned pass (its own session dead, this tree's
  // lease already taken over by a replacement session working a DIFFERENT
  // PR) could push straight through, cross-shipping this pass's uncommitted
  // work onto that other session's PR (docomply-review, a reference-implementation pull request round 6).
  // Placed immediately before the push, not earlier in this function,
  // for the identical reason `assert-post-allowed.ts`'s callers check right
  // before their own POST: the smaller the gap between the check and the
  // mutation it guards, the smaller the window a takeover has to land in.
  //
  // Skipped entirely under `--dry-run`: that mode updates nothing remote (see
  // the `--dry-run` handling below, already the established contract for the
  // post-push head check), so there is no irreversible mutation for the fence
  // to guard and nothing to cross-ship. Checking anyway made a rehearsal fail
  // with exit 11 purely because another session owns the lease, contradicting
  // this function's own "`--dry-run` returns on the push command's own
  // status" doc comment (docomply-review, a reference-implementation pull request).
  const dryRun = extra.includes("--dry-run");
  const fenceCtx = dryRun ? null : await resolveFenceContext("guarded-push.ts");
  // `null` means either a dry run (nothing to guard) or no repository is in
  // play at all — the standalone case (see `resolveFenceContext`'s own doc)
  // — so there is no lease this process could be conflicting with, and
  // nothing to check or hold.
  //
  // The PER-PR half first, alongside the tree half below — this
  // call was tree-only until now, checking only "does another live session
  // own this TREE" and never "does another live session own THIS PR's
  // per-PR lease." A `clear-lease --all` revoking this pass's per-PR lease,
  // followed by a replacement session claiming the SAME pr from a DIFFERENT
  // worktree, left that exact takeover invisible to the tree-only check —
  // the tree lease this pass still (locally) believes it holds says nothing
  // about who now owns the PR (chatgpt-codex-connector round 11, a reference-implementation pull request).
  //
  // HELD across the push itself, like `treeLock` below: before
  // this, `assertRemoteMutationAllowed` returned `void` having taken no lock
  // at all — a point-in-time read of the PR's per-PR lease set, with nothing
  // held once it returned, left the exact window open a DIFFERENT worktree's
  // admission needs to land in: this push can legitimately run for the whole
  // of `$DRIVE_PR_PUSH_TIMEOUT` (an hour by default), and nothing stopped a
  // second worktree from claiming this PR's per-PR lease and mutating it
  // while this push was still in flight — the identical cross-shipping
  // hazard an earlier change (`treeLock`, below) closed for the TREE axis, still open
  // here on the PR axis until now (chatgpt-codex-connector, a reference-implementation pull request review,
  // deferred to).
  const remoteLock =
    fenceCtx === null
      ? null
      : await assertRemoteMutationAllowed(fenceCtx, pr, "guarded-push.ts");
  // Heartbeat starts the INSTANT `remoteLock` is acquired, not after
  // `assertTreeMutationAllowed` below also succeeds (docomply-review, PR
  // #4164 round 3): that call's own `acquire()` can itself wait up to
  // `LOCK_ACQUIRE_MAX_SEC` (300s) under genuine contention on the TREE
  // lock, and until this round `remoteLock` sat un-heartbeated for that
  // whole wait — long enough, under an operator-shortened
  // `$DRIVE_PR_LOCK_STALE_MIN`, for a rival to treat it as abandoned and
  // break it before this process ever reaches its own push. `treeLock` is
  // declared here (not assigned) purely so this closure can reference it
  // before it exists; the `?.` makes touching a not-yet-acquired lock a
  // no-op rather than a crash.
  let treeLock: Awaited<ReturnType<typeof assertTreeMutationAllowed>> | null =
    null;
  // Heartbeat both held locks' mtimes for as long as they are held
  // (chatgpt-codex-connector, a reference-implementation pull request; an earlier change for `remoteLock`): `git push`
  // here can legitimately run for the whole of `$DRIVE_PR_PUSH_TIMEOUT` (an
  // hour by default, pre-push hooks included), far longer than either lock's
  // own default 10-minute staleness window, and nothing else touches their
  // mtimes while the only thing running is the `git` subprocess below.
  // Without this, a contending `acquire()` elsewhere — any other mutating
  // `drive-state.ts` call for `treeLock`, a rival claim for `remoteLock` —
  // legitimately breaks the lock out from under a still-alive, still-pushing
  // session once the hold crosses that window, reopening the exact takeover
  // gap holding it across the push exists to close. `null` only when nothing
  // was acquired at all (the `--dry-run` / no-repository case), so there is
  // nothing to heartbeat. (The mailbox lock is deliberately NOT one of them:
  // it is held for a read only, never across the push — see
  // `readPushHoldUnderLock`.)
  const lockHeartbeat =
    fenceCtx === null
      ? null
      : setInterval(() => {
          remoteLock?.touch();
          treeLock?.touch();
        }, lockHeartbeatMs());

  // Releases everything held across the push. One closure because it is
  // needed on every path out — a refused tree fence, an unreadable mailbox,
  // an active hold, and the push's own `finally` — and a hand-copied release
  // list is exactly what drifts when a lock is added or removed.
  const releaseLocks = (): void => {
    if (lockHeartbeat !== null) clearInterval(lockHeartbeat);
    for (const lock of [remoteLock, treeLock]) {
      if (lock !== null) {
        lock.release();
        lock.dispose();
      }
    }
  };

  // The tree half: a point-in-time check with the lock released
  // before `git push` even starts leaves the exact window open a replacement
  // session's takeover needs to cross-ship uncommitted work onto a different
  // PR — the identical TOCTOU every state-mutating path already closes via
  // `acquireIdentifiedTreeGuardNow` / `acquireSessionlessTreeGuardNow`.
  // Released in `finally`, alongside `remoteLock`, once the push has
  // completed (or failed) — never held through the post-push API
  // verification below, which reads remote state the push has already made
  // irreversible and has nothing left for either lock to protect.
  //
  // Wrapped so a throw HERE — including this fence's own expected exit-11
  // refusal — stops the heartbeat and releases the ALREADY-ACQUIRED
  // `remoteLock` before propagating, rather than leaving either running
  // until process exit's safety net eventually clears them: this refusal
  // can fire well before the push (and therefore this whole process) would
  // otherwise end, and a rival worktree waiting on `remoteLock` has no
  // reason to keep waiting once THIS worktree has already refused to
  // proceed (docomply-review, a reference-implementation pull request round 1).
  try {
    treeLock =
      fenceCtx === null
        ? null
        : await assertTreeMutationAllowed(fenceCtx, pr, "guarded-push.ts");
  } catch (e) {
    releaseLocks();
    throw e;
  }

  // The mailbox 'hold-push' directive (lib/state/mailbox.ts) — checked at the
  // same last-possible-moment point as the two lease fences just above, for
  // the identical reason: this call can have waited on `LOCK_ACQUIRE_MAX_SEC`
  // for either lock, long enough for a hold sent after an earlier check to
  // still apply. Skipped under `--dry-run` like both fences, since a
  // rehearsal has nothing for a hold to prevent. Unlike the lease fences this
  // is not a session-identity mechanism — it is a live session's explicit
  // request, read fresh, with the identical fail-closed rule an unreadable
  // directive log gets everywhere else in that module.
  //
  // This is the EARLY half of a two-part check, and the cheap one: it refuses
  // before a pre-push hook that can run for tens of minutes starts. It cannot
  // be the only one — `git push` runs that whole hook chain before
  // transferring anything, and a hold sent DURING it would otherwise never
  // reach the push already underway. The LATE half is
  // `push-hold-recheck.ts`, the pre-push chain's last step, which this script
  // arms by exporting the PR and mailbox directory to the push below. The
  // mailbox lock is therefore held for the read only: holding it across the
  // push (PR #4446 round 30) made a concurrent `send` block for the hook's
  // whole duration instead of landing, which delayed the hold rather than
  // honouring it. The one window left is git's own hook-exit-to-transfer gap.
  let holdRecheckDir: string | null = null;
  if (!dryRun) {
    let held: { blocked: boolean; reason: string };
    try {
      holdRecheckDir = await resolveMailboxDir();
      held = await readPushHoldUnderLock(
        holdRecheckDir,
        pr,
        "guarded-push.ts (hold check)",
      );
    } catch (e) {
      releaseLocks();
      throw e;
    }
    if (held.blocked) {
      releaseLocks();
      fail(
        PUSH_HELD_EXIT,
        `guarded-push: ${held.reason}.`,
        "Nothing was pushed. Clear it with:",
        `  bun <skill-dir>/scripts/mailbox.ts send ${pr} --kind directive --from <you> --command resume --target hold-push`,
        "then re-run.",
      );
    }
  }

  // `push-hold-recheck.ts` creates this file only when IT aborted the push
  // for a hold, which is the sole proof of cause available here.
  //
  // Everything from here to the push's own `finally` runs with the locks and
  // heartbeat live, so the marker directory is allocated INSIDE the span the
  // `finally` releases: an `mkdtempSync` failure outside it would leave the
  // heartbeat timer pinning the process with both locks held.
  let abortDir: string | null = null;
  let holdAbortFile: string | null = null;
  const holdNonce = randomUUID();
  let push: Awaited<ReturnType<typeof git>>;
  try {
    if (holdRecheckDir !== null) {
      abortDir = mkdtempSync(join(tmpdir(), "guarded-push-hold-"));
      holdAbortFile = join(abortDir, "hold-recheck-aborted");
    }
    push = await git(
      ["push", ...extra, "origin", `${localSha}:refs/heads/${headRef}`],
      {
        timeoutSec: pushTimeout.seconds,
        // `opts.env` REPLACES the child's environment, so extend
        // `process.env` rather than pass the variables alone. They arm
        // `push-hold-recheck.ts` in the pre-push chain (see above); a
        // dry run pushes nothing, so it arms nothing — and must also strip
        // any arming the CALLER's own environment already carries, or the
        // lefthook entry would treat the rehearsal as armed.
        env: dryRun
          ? withoutHoldRecheckEnv(process.env)
          : holdRecheckDir === null
            ? undefined
            : {
                ...process.env,
                DRIVE_PR_HOLD_RECHECK_PR: pr,
                DRIVE_PR_MAILBOX_DIR: holdRecheckDir,
                ...(holdAbortFile === null
                  ? {}
                  : { DRIVE_PR_HOLD_RECHECK_ABORT_FILE: holdAbortFile }),
                DRIVE_PR_HOLD_RECHECK_NONCE: holdNonce,
              },
      },
    );
  } finally {
    releaseLocks();
  }
  const pushOutput = `${push.stdout}${push.stderr}`;
  let holdAborted = false;
  if (holdAbortFile !== null) holdAborted = existsSync(holdAbortFile);
  // The recheck could not write its marker: it says so in-band, in the one
  // channel that survives git relaying the hook's output. The sentinel embeds
  // this push's own nonce, so other hooks' or the remote's output cannot
  // forge it.
  if (pushOutput.includes(holdAbortUnmarkedSentinel(holdNonce)))
    holdAborted = true;
  // Temp-file cleanup is best effort: it must not replace the push's outcome
  // (a push that succeeded still owes the remote-head confirmation below).
  if (abortDir !== null) {
    try {
      rmSync(abortDir, { recursive: true, force: true });
    } catch {
      // ignored — a leaked tmp dir is harmless, a lost push result is not
    }
  }
  if (pushOutput !== "")
    process.stderr.write(
      pushOutput.endsWith("\n") ? pushOutput : `${pushOutput}\n`,
    );
  if (push.timedOut) {
    fail(
      1,
      `guarded-push: push to PR #${pr}'s head branch (${headRef}) exceeded`,
      `${pushTimeout.seconds}s and was killed.`,
      "Whether any of it landed is unknown — check the branch before treating",
      "this round as pushed. Raise $DRIVE_PR_PUSH_TIMEOUT if the pre-push gates",
      "legitimately need longer on this machine.",
    );
  }
  if (push.code !== 0) {
    // A push the pre-push hook chain aborted because a hold landed during
    // validation comes back as a bare non-zero status, indistinguishable by
    // exit code from a failed gate. The recheck marks its own abort, so a
    // gate failure or remote rejection is never relabelled by a hold that
    // merely happens to be active by the time we look.
    if (holdAborted) {
      fail(
        PUSH_HELD_EXIT,
        `guarded-push: push to PR #${pr}'s head branch (${headRef}) was aborted by the pre-push hold recheck.`,
        "Nothing was transferred. Clear the hold with:",
        `  bun <skill-dir>/scripts/mailbox.ts send ${pr} --kind directive --from <you> --command resume --target hold-push`,
        "then re-run.",
      );
    }
    fail(
      1,
      `guarded-push: push to PR #${pr}'s head branch (${headRef}) failed`,
    );
  }

  // A dry run updated NOTHING, by definition — so the head check below, which
  // waits for the PR to report the SHA we pushed, can only ever time out and
  // report a push that "may not be on the pull request". That turned the one
  // allowlisted option whose whole purpose is a no-op rehearsal into a
  // guaranteed exit 1 after the full verification budget (docomply-review,
  // a reference-implementation pull request round 1). The push command's own status is the entire answer
  // here; there is no remote state to confirm.
  if (dryRun) {
    console.error(
      `guarded-push: --dry-run — PR #${pr}'s head branch (${headRef}) was NOT updated`,
    );
    return 0;
  }

  // Confirm the PR actually advanced to what we pushed. This is the check
  // that survives every remaining way the push could have gone somewhere else
  // — a fork's head repository, a protected-branch rewrite, a racing
  // force-push. Replication lag means the API can still report the previous
  // SHA for a few seconds, so poll briefly rather than failing on the first
  // read.
  const triesRaw = process.env.DRIVE_PR_PUSH_VERIFY_TRIES ?? "10";
  const intervalRaw = process.env.DRIVE_PR_PUSH_VERIFY_INTERVAL ?? "6";
  const tries = isDigits(triesRaw) ? Number.parseInt(triesRaw, 10) : 10;
  const interval = isDigits(intervalRaw) ? Number.parseInt(intervalRaw, 10) : 6;
  let apiHead = "";
  for (let i = 0; i < tries; i++) {
    const r = await ghCall(
      ["pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"],
      {
        stderr: "ignore",
      },
    );
    apiHead = r.code === 0 ? r.stdout.trim() : "";
    if (apiHead === localSha) {
      console.error(
        `guarded-push: PR #${pr} is now at ${localSha.slice(0, 12)}`,
      );
      return 0;
    }
    if (i + 1 < tries) await sleep(interval);
  }

  console.error(
    `guarded-push: pushed ${localSha.slice(0, 12)} to ${headRef}, but PR #${pr} still reports ${apiHead === "" ? "unknown" : apiHead}.`,
  );
  console.error(
    "The commits may not be on the pull request. Check the branch and head repository",
  );
  console.error("before treating this round as landed.");
  return 1;
}

runMain("guarded-push.ts", main);
