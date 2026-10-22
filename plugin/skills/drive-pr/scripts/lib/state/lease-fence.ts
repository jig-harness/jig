/** Recheck ownership before remote or tree mutations; an indeterminate read cannot authorize a mutation. */
import {
  type Session,
  leaseStaleMin,
  treeLeasePathFor,
} from "./lease-model.ts";

import {
  type DirIdentity,
  prRemoteMutationLock,
  statDirIdentity,
  filterLeaseFilesForActor,
  filterLeaseFilesFor,
  leaseFilesForActor,
  leaseFilesFor,
  sameDirIdentity2,
  assertStateDirIdentityUnchanged,
  treeLeaseLock,
} from "./lease-files.ts";

import {
  type PathLock,
  LOCK_ACQUIRE_MAX_SEC,
  LockAcquireTimeoutError,
} from "./lock.ts";

import {
  resolveLegacyFallbackDir,
  MAX_DIR_REFRESH_ATTEMPTS,
  refreshOverrideEntries,
} from "./lease-context.ts";

import { retry } from "../../../../../shared/retry.ts";

import { fail } from "../cli.ts";

import {
  readLeaseForFence,
  isMine,
  leaseAlive,
  leaseHolderLabel,
  ageLabel,
  leaseLivenessHint,
  treeLeaseUnreadableAndFresh,
  readTreeLease,
} from "./lease-records.ts";

import { treeIsMine } from "./lease-tree.ts";

export async function assertRemoteMutationAllowed(
  ctx:
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: true;
        overrideEntries: string[];
        stateDirIdentity: DirIdentity;
      }
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: false;
        legacyStateDirForFallback: string;
      },
  pr: string | null,
  label: string,
): Promise<PathLock | null> {
  // Canonicalize before comparing/searching, not just validate: `isDigits`
  // accepts a leading-zero string like "0999", which GitHub's numeric issue
  // route treats identically to "999", but neither a strict `===` nor
  // `leaseFilesFor`'s own filename PREFIX match would find a lease stored
  // under the canonical form otherwise — silently narrowing an explicit
  // `--pr 0999` to zero candidates and authorizing the POST past a live one.
  //
  // `BigInt`, not `Number`: `isDigits` only guarantees an all-digit string,
  // not one that fits a float's 53-bit mantissa — `String(Number(pr))` is
  // LOSSY past `Number.MAX_SAFE_INTEGER` (silently rounds to a neighboring
  // integer) and outright wrong past `Number.MAX_VALUE` (`Infinity`), either
  // of which enumerates the wrong — often empty — lease set and authorizes a
  // POST past a live lease for the real identifier. `BigInt` has no such
  // ceiling and canonicalizes leading zeros the same way `.toString()`
  // always has.
  const canonicalPr = pr === null ? null : BigInt(pr).toString();
  // Resolved FRESH, before `remoteLock` below is even constructed — not
  // reused from `resolveFenceContext`'s original snapshot decision. The lock
  // path is keyed by `ctx.stateDir`, so a stale snapshot does not just make
  // `checkAllowed`'s enumeration read the wrong directory (the fix for that
  // is below): it makes THIS lock guard the wrong directory too, and a fresh
  // admission via `claimPrLease` — which resolves its OWN lock path live —
  // would then acquire a DIFFERENT lock file than this call holds, so the
  // two never contend at all despite both naming the identical PR
  //. The loop below
  // additionally re-checks after `acquire()` itself, which can wait up to
  // `LOCK_ACQUIRE_MAX_SEC` — long enough for the choice to move again.
  if (!ctx.fromOverride) {
    const freshStateDir = resolveLegacyFallbackDir(
      ctx.legacyStateDirForFallback,
    );
    if (freshStateDir !== ctx.stateDir) {
      ctx = { ...ctx, stateDir: freshStateDir };
    }
  }
  // Acquired FIRST, before this function's own enumeration even
  // runs, and returned to the caller STILL HELD: the identical "through the
  // mutation, not just the check" shape `assertTreeMutationAllowed` already
  // carries for the TREE axis, applied here to the PR axis this function was
  // deferred on when that fix first shipped. Before this, the function below
  // returned `void` having taken no lock at all — a point-in-time read of the
  // per-PR lease set, with nothing held once it returned, left the exact
  // window a replacement worktree's admission needs to land in:
  // `guarded-push.ts` starts a `git push` that can legitimately run for the
  // whole of `$DRIVE_PR_PUSH_TIMEOUT` (an hour, by default), and nothing
  // stopped a DIFFERENT worktree from claiming this PR's per-PR lease and
  // mutating it while that push was still in flight.
  //
  // Keyed by PR ALONE — `prRemoteMutationLockPathFor`, one file for every
  // worktree driving this PR — mirroring how `treeLeasePathFor` is keyed by
  // actor alone; NOT the per-(tree, PR) `leasePathFor` this function already
  // enumerates below, which is what let two DIFFERENT trees each resolve a
  // lease of their own with no shared file to contend on in the first place.
  //
  // Skipped entirely when no PR is named (`canonicalPr === null`,
  // `assert-post-allowed.ts`'s standalone actor-wide path): there is no
  // single PR this call is protecting, so there is nothing for a lock keyed
  // by PR to guard — the same reasoning `assertTreeMutationAllowed`'s own
  // `pr === null` case documents for `treeIsMine`.
  //
  // `claimPrLease` (this module's admission WRITE path) takes the SAME lock
  // — and HOLDS it through its own admission write rather than releasing
  // right after acquiring, for the identical reason this function holds it
  // through the caller's mutation: a release-then-write gap is itself a
  // window a DIFFERENT acquirer can land in — so a takeover attempt waits
  // out an in-flight hold here, bounded the same way every acquisition in
  // this module is (`LOCK_ACQUIRE_MAX_SEC` at most, `$DRIVE_PR_LOCK_TIMEOUT`
  // if smaller), refusing with exit 11 rather than racing past a check that
  // saw nothing because nothing had renewed yet — see its own comment for
  // why that bound, not the true worst case, is what a single `acquire()`
  // may wait. See the lock-ordering note beside `treeLeaseLock`'s own
  // definition for where this sits relative to the other locks in this
  // module.
  // Bounded retry: `ctx.stateDir` was already refreshed once above, but the
  // choice can move AGAIN while `acquire()` itself waits — up to
  // `LOCK_ACQUIRE_MAX_SEC` — for a rival to release it, and that wait is
  // exactly a window a concurrent admission can land in. Re-checking only
  // after acquiring, and releasing-and-retrying against the fresher
  // directory when it moved, closes that second window too rather than just
  // narrowing the first one. `MAX_DIR_REFRESH_ATTEMPTS` bounds it
  // defensively — the decision is monotonic (legacyDir → newDir, never
  // back), so a real clone converges in one extra iteration at most; this
  // only guards against a defect turning that into a spin.
  const moved = Symbol("state directory moved");
  const remoteLock = await retry(
    async (iteration): Promise<PathLock | null> => {
      const attempt = iteration - 1;
      const remoteLock =
        canonicalPr === null
          ? null
          : prRemoteMutationLock(ctx.stateDir, canonicalPr);
      if (remoteLock !== null) {
        try {
          await remoteLock.acquire(LOCK_ACQUIRE_MAX_SEC);
        } catch (e) {
          // Even a failed acquisition owns a cleanup registration. Dispose it
          // so repeated attempts do not retain unused handles.
          remoteLock.dispose();
          // `LockAcquireTimeoutError`, converted to the SAME exit 11 every
          // other live-foreign-driver refusal in this module uses — not
          // `acquire()`'s own generic exit 1 "or the lock is wedged": this is
          // `guarded-push.ts`'s and `answer-summary-finding.ts`'s OWN fence,
          // the one caller class this lock exists for, so misreporting an
          // ordinary in-flight rival mutation as a possibly-wedged lock here
          // would be the exact misdiagnosis `claimPrLease`'s identical
          // conversion already avoids.
          // Any OTHER `ExitError` (the ownership-marker infrastructure failure)
          // keeps its own exit code and message, unchanged.
          if (!(e instanceof LockAcquireTimeoutError)) throw e;
          fail(
            11,
            `${label}: PR #${canonicalPr} has an irreversible remote mutation (a push or a posted reply) in flight from another worktree, and it has not cleared yet.`,
            "",
            "Refusing to post rather than proceed alongside it — the identical",
            "cross-shipping hazard this PR-wide lock exists to close.",
            "This is not necessarily wedged: a push can legitimately run for the",
            "whole of $DRIVE_PR_PUSH_TIMEOUT (an hour, by default, pre-push hooks",
            "included), longer than this wait was bounded to. Retry once it",
            "completes.",
          );
        }
      }
      if (ctx.fromOverride || remoteLock === null) return remoteLock;
      const freshStateDir = resolveLegacyFallbackDir(
        ctx.legacyStateDirForFallback,
      );
      if (freshStateDir === ctx.stateDir) return remoteLock;
      if (attempt >= MAX_DIR_REFRESH_ATTEMPTS) {
        remoteLock.release();
        remoteLock.dispose();
        fail(
          1,
          `${label}: the legacy-vs-relocated state directory choice kept changing while acquiring PR #${canonicalPr}'s remote-mutation lock.`,
          "",
          "Refusing to post. This should converge in one retry (the choice only",
          "ever moves legacyDir -> newDir, never back); repeated movement means",
          "something is wrong rather than a genuine one-time migration handoff",
          ".",
        );
      }
      remoteLock.release();
      remoteLock.dispose();
      ctx = { ...ctx, stateDir: freshStateDir };
      throw moved;
    },
    {
      attempts: MAX_DIR_REFRESH_ATTEMPTS + 1,
      baseMs: 0,
      maxMs: 0,
      retryIf: (error) => error === moved,
    },
  );
  // Re-enumerate the override snapshot AFTER the wait above, not before
  //: `ctx.overrideEntries` was
  // captured by the CALLER's own `resolveFenceContext`, before this
  // function — and its `remoteLock.acquire()` above — ever ran. Refreshing
  // unconditionally (not only when the acquire visibly blocked) because
  // there is no cheap way to distinguish "acquired instantly" from
  // "acquired after a wait" from here, and the race this closes can land
  // in a gap of ANY size, not only a long one.
  //
  // The non-override path's own equivalent refresh already happened above,
  // inside the lock-acquisition loop — that is where the RETRY has to live,
  // since a directory change there means a DIFFERENT lock path, not just a
  // different enumeration target. Nothing further to do for it here.
  //
  // Inside the SAME try/catch as `checkAllowed()`, not before it
  //: `refreshOverrideEntries` can
  // itself `fail()` (a read error, or a directory-identity mismatch), and
  // sitting outside the cleanup below meant that throw escaped without
  // ever releasing or disposing `remoteLock` — a caller that catches the
  // refusal and stays alive would keep holding the lock (and its process
  // listeners) indefinitely, blocking every later push, POST, or admission
  // attempt on this PR until stale-lock recovery.
  try {
    if (ctx.fromOverride && remoteLock !== null) {
      const refreshed = refreshOverrideEntries(
        label,
        ctx.stateDir,
        ctx.stateDirIdentity,
      );
      ctx = { ...ctx, ...refreshed };
    }
    checkAllowed();
  } catch (e) {
    if (remoteLock !== null) {
      remoteLock.release();
      remoteLock.dispose();
    }
    throw e;
  }
  return remoteLock;

  function checkAllowed(): void {
    // A known PR is checked PR-WIDE — every worktree's lease for it, not just
    // this tree's own actor. A driver can legitimately move to a DIFFERENT
    // worktree (this tree's died; a successor started fresh elsewhere), and an
    // orphaned pass left running in the OLD tree must still see that
    // successor's live lease: `leaseFilesForActor` is blind to every OTHER
    // tree's leases by construction, so a detached pass there finds only its
    // own (dead) driver's lease — not-alive, not-mine, refuses nothing — and
    // posts alongside the session actually driving the PR right now.
    // `leaseFilesFor` is the PR-wide mirror of `leaseFilesForActor` built for
    // `assertNoForeignDrive`'s claim-time version of this same question — reused
    // here, not reimplemented, but still read through `readLeaseForFence`
    // rather than `liveLeasesFor`'s `readLease`: that reader collapses absent
    // and unreadable to the same "no lease", which is the exact fail-open this
    // whole function exists to close, so the claim-time helper is right for
    // claiming and wrong for posting for the same reason it always has been.
    //
    // With no PR named, PR-wide is not answerable without a network round-trip
    // this hot-path fence does not spend, so the actor-wide check remains —
    // sound for the reason `actor.ts` gives: at most one drive runs per TREE,
    // so a live foreign lease found there is a second session in it whichever
    // PR it names.
    // The override case never re-ENUMERATES the directory here —
    // `ctx.overrideEntries` is the one and only directory LISTING
    // `resolveFenceContext` already performed, and this filters that in-memory
    // snapshot instead of asking the filesystem for the name list again. That
    // closes the NAME-LIST half of the class of races narrower fixes kept
    // leaving a corner open (statSync-then-later-read ordering, then an
    // `ENOENT`-only indeterminate flag on the later read, both defeated by
    // renaming the directory away and creating an EMPTY one at the same
    // pathname): a rename-and-recreate cannot inject or hide a NAME this fence
    // reasons about, because the list was already fixed before it could land.
    //
    // It does not close the CONTENT half — each candidate's lease still has to
    // be OPENED fresh, below, and that per-file read is a genuine later moment
    // a rename-and-recreate can still land in front of: the file this
    // enumeration saw may no longer be reachable at this path if the
    // directory itself was swapped, and `readLeaseForFence` would then report
    // `absent` for a lease that is still live in the directory that moved.
    // `enumerationIdentity` below is what closes that: for the override path it
    // is `ctx.stateDirIdentity`, captured by `resolveFenceContext` in the same
    // breath as `ctx.overrideEntries`; for the non-override path — which has no
    // earlier snapshot to reuse, and reads live because for it "never existed"
    // is the ordinary case, not an anomaly to fence against — it is captured
    // fresh immediately below, right after that path's own live enumeration.
    // Every `absent` read, and the moment just before this function authorizes
    // the post, re-confirms that identity before trusting it — failing closed
    // on a mismatch instead of reading a swapped directory as an all-clear.
    // The opening bracket of the pair described below `candidates`. Taken
    // BEFORE the live enumeration so the two readings straddle it; unused on
    // the override path, which does no enumeration here at all.
    const beforeEnumeration: DirIdentity | null = ctx.fromOverride
      ? null
      : statDirIdentity(ctx.stateDir);
    const candidates = leaseCandidates();
    let enumerationIdentity: DirIdentity | null;
    if (ctx.fromOverride) {
      enumerationIdentity = ctx.stateDirIdentity;
    } else {
      enumerationIdentity = statDirIdentity(ctx.stateDir);
      if (!sameDirIdentity2(beforeEnumeration, enumerationIdentity)) {
        fail(
          1,
          `${label}: the drive state directory was replaced while its lease set was being listed:`,
          `  ${ctx.stateDir}`,
          "",
          "Refusing to post. The listing this check would judge from was not taken",
          "from a single, stable directory, so a lease it did not see may still be",
          "live in the directory that moved.",
        );
      }
    }
    for (const c of candidates) checkCandidate(c, enumerationIdentity);
    assertStateDirIdentityUnchanged(
      label,
      ctx.stateDir,
      enumerationIdentity,
      "right before authorizing the post",
    );
  }
  function leaseCandidates(): { file: string; pr: string }[] {
    return ctx.fromOverride
      ? canonicalPr === null
        ? filterLeaseFilesForActor(ctx.overrideEntries, ctx.stateDir, ctx.actor)
        : filterLeaseFilesFor(
            ctx.overrideEntries,
            ctx.stateDir,
            canonicalPr,
          ).map((file) => ({ file, pr: canonicalPr }))
      : canonicalPr === null
        ? leaseFilesForActor(ctx.stateDir, ctx.actor)
        : leaseFilesFor(ctx.stateDir, canonicalPr).map((file) => ({
            file,
            pr: canonicalPr,
          }));
  }

  function checkCandidate(
    c: { file: string; pr: string },
    enumerationIdentity: ReturnType<typeof statDirIdentity>,
  ): void {
    const read = readLeaseForFence(c.file);
    if (read.kind === "unreadable") {
      fail(
        1,
        `${label}: PR #${c.pr} has a drive lease that could not be read (${read.why}).`,
        `  ${c.file}`,
        "",
        "Refusing to post. That file is exactly the evidence of whether another live",
        "session is driving this PR, so an unreadable one is not an all-clear — it",
        "is the question going unanswered, in front of a mutation with no undo",
        ".",
        "",
        "Fix the file or remove it deliberately, then retry:",
        `  drive-state.ts lease ${c.pr}          # read what is there`,
        `  drive-state.ts clear-lease ${c.pr}    # drop it, if that session is gone`,
      );
    }
    if (read.kind === "absent") {
      // See `enumerationIdentity` above: a rename-and-recreate between the
      // enumeration and THIS read makes an `absent` result a lie about a
      // directory that no longer exists at this path. Re-confirming here is
      // what turns that into a refusal instead of a silent "nobody here".
      assertStateDirIdentityUnchanged(
        label,
        ctx.stateDir,
        enumerationIdentity,
        `while treating PR #${c.pr}'s lease as absent`,
      );
      return;
    }
    const held = read.lease;
    // DELIBERATELY NOT `isRecycledPid`-aware, unlike `claimLease` and
    // `assertNoForeignDrive`. Those guard an ADMISSION decision —
    // a false refusal there costs a retry, or a wait bounded by the
    // staleness window, both recoverable. This fence guards a POST with no
    // undo, and "EVERY OTHER OUTCOME REFUSES" (this function's own header)
    // is the standing rule for exactly that asymmetry: it may allow only on
    // a positively established absence of ANY live rival, `isMine` or not —
    // never on a proof that the rival is merely a DIFFERENT one, however
    // sound that proof is. Locked in by the "session-started token" suite
    // (pid recycling), which asserts exit 11 for this identical fixture
    // shape; an `isRecycledPid` carve-out here was tried and reverted for
    // exactly that conflict.
    if (isMine(held, ctx.session, ctx.actor) || !leaseAlive(held)) return;
    const sameTree = held.actor === ctx.actor;
    const where = sameTree
      ? "this working tree"
      : `a DIFFERENT working tree (${held.worktree === "" ? held.actor : held.worktree})`;
    fail(
      11,
      `${label}: PR #${c.pr} is being driven from ${where} by another live holder (${leaseHolderLabel(held)}).`,
      `It took the lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      sameTree
        ? "Refusing to post. Two sessions in ONE tree share one actor id, so both post"
        : "Refusing to post. A live session elsewhere is actively driving this PR, so",
      sameTree
        ? "their own outcome reply and every thread ends up with two — which is not"
        : "posting here doubles every outcome reply it makes from this point on — not",
      sameTree
        ? "repairable once the comments are up, and corrupts the reviewer-scoring"
        : "repairable once the comments are up, and it corrupts the reviewer-scoring",
      sameTree
        ? "sample they feed. Unlike drive state, a comment has no undo, so"
        : "sample it feeds. Unlike drive state, a comment has no",
      sameTree
        ? "this refusal comes BEFORE the mutation rather than after it."
        : "undo, so this refusal comes BEFORE the mutation rather than after it.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${c.pr}`,
      `Otherwise the lease clears itself once that holder has left drive state`,
      `untouched for ${leaseStaleMin()}m.`,
    );
  }
}

/**
 * `assertRemoteMutationAllowed`'s TREE-WIDE counterpart: may THIS
 * session still perform an irreversible external mutation on this tree's
 * behalf?
 *
 * `assertRemoteMutationAllowed` guards only the PER-PR lease.
 * `guarded-push.ts` — the one script that performs the single most
 * irreversible external mutation in this whole skill, `git push` — needs
 * this fence too: without it an orphaned pass (its own session dead, the
 * tree already taken over by a replacement session working a different PR)
 * could push straight through, cross-shipping uncommitted work between two
 * PRs in the same checkout — exactly the hazard the tree lease exists to
 * close.
 *
 * Takes the SAME resolved `ctx` `assertRemoteMutationAllowed` does — callers
 * should invoke both from one `resolveFenceContext` call, not resolve twice
 * — but reads only the SINGLE, well-known tree-lease path, not an
 * enumeration, so it does not need that function's directory-identity-swap
 * protection: there is no directory listing here for a rename-and-recreate
 * to defeat, only one `readFileSync` at a path this actor's identity already
 * pins.
 *
 * Passes when: no tree lease exists (nothing has ever claimed one — the
 * standalone case, or a genuinely idle tree); it belongs to THIS caller
 * (`treeIsMine`: pid/host/token for a `holder: 'session'` record,
 * matching `pr` for a `holder: 'worktree'` one, since that file is no
 * longer written by identified sessions alone); or its owner is gone or has
 * stopped driving (`leaseAlive` false — an ended drive is not a rival).
 * Refuses, fail-closed, on a file that exists but cannot be parsed
 * (mirroring `treeLeaseUnreadableAndFresh`'s ruling everywhere else in this
 * module) and on a live, different holder — session or sessionless.
 *
 * `pr` is `null` for the one caller with no PR in play at all
 * (`assert-post-allowed.ts`'s standalone path) — `treeIsMine` then never
 * treats a `holder: 'worktree'` record as this caller's own, which is the
 * safe direction: a caller that cannot NAME the pr it is posting for cannot
 * claim ownership of a specific-pr sessionless resolver's record either.
 */
// ACQUIRES `treeLeaseLock` and returns it STILL HELD: the identical "through
// the mutation, not just the check" fix `acquireIdentifiedTreeGuardNow` and
// `acquireSessionlessTreeGuardNow` already give every STATE-mutating path.
// An earlier revision of this function checked and returned `void`,
// releasing nothing because it had acquired nothing — a point-in-time read
// with the lock released (never taken) before `git push` even started, so a
// replacement session's takeover could land in the exact window this
// function exists to close, and `guarded-push.ts` would push straight
// through it. The caller now holds the returned lock across the push itself
// and releases it only once the push has completed — see `guarded-push.ts`.
//
// Lock order is unchanged from the other two tree guards: this is the ONLY
// lock this function takes, so it cannot invert against state-mutex(pr) →
// `treeLeaseLock`.
export async function assertTreeMutationAllowed(
  ctx:
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: true;
      }
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: false;
        legacyStateDirForFallback: string;
      },
  pr: string | null,
  label: string,
): Promise<PathLock> {
  // Same re-resolution `assertRemoteMutationAllowed` runs, and the same
  // reason: `ctx.stateDir` is a single snapshot decision `resolveFenceContext`
  // made, possibly a while before this call. Refreshed HERE, before `path` is
  // even computed, so the lock this function takes is on the directory the
  // caller would ACTUALLY be checked against, not a stale pre-admission one
  // (the same time-of-check-to-time-of-use root cause, a different consumer of
  // the same fence context). The loop below closes the SAME gap
  // `assertRemoteMutationAllowed`'s own loop does — the choice can still move
  // again while `lock.acquire()` itself waits.
  let stateDir = ctx.fromOverride
    ? ctx.stateDir
    : resolveLegacyFallbackDir(ctx.legacyStateDirForFallback);
  let path = treeLeasePathFor(stateDir, ctx.actor);
  let lock = treeLeaseLock(path);
  const moved = Symbol("state directory moved");
  await retry(
    async (iteration) => {
      const attempt = iteration - 1;
      // EXPLICIT bound — see `acquireSessionlessTreeGuardNow`'s identical
      // comment; the same reasoning applies unchanged here.
      await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
      if (ctx.fromOverride) return;
      const freshStateDir = resolveLegacyFallbackDir(
        ctx.legacyStateDirForFallback,
      );
      if (freshStateDir === stateDir) return;
      if (attempt >= MAX_DIR_REFRESH_ATTEMPTS) {
        lock.release();
        lock.dispose();
        fail(
          1,
          `${label}: the legacy-vs-relocated state directory choice kept changing while acquiring this working tree's lease lock.`,
          "",
          "Refusing to post. This should converge in one retry (the choice only",
          "ever moves legacyDir -> newDir, never back); repeated movement means",
          "something is wrong rather than a genuine one-time migration handoff",
          ".",
        );
      }
      lock.release();
      lock.dispose();
      stateDir = freshStateDir;
      path = treeLeasePathFor(stateDir, ctx.actor);
      lock = treeLeaseLock(path);
      throw moved;
    },
    {
      attempts: MAX_DIR_REFRESH_ATTEMPTS + 1,
      baseMs: 0,
      maxMs: 0,
      retryIf: (error) => error === moved,
    },
  );
  try {
    checkAllowed();
  } catch (e) {
    lock.release();
    lock.dispose();
    throw e;
  }
  return lock;

  function checkAllowed(): void {
    if (treeLeaseUnreadableAndFresh(path)) {
      fail(
        1,
        `${label}: this working tree's TREE lease exists but could not be read as one:`,
        `  ${path}`,
        "",
        "Refusing to post. That file is exactly the evidence of whether another",
        "live session already holds this tree, so proceeding would be a claim this",
        "process could not actually verify.",
        "",
        `If it is debris, remove this file deliberately with your file tools: ${path}`,
        `Otherwise it stops blocking on its own once ${leaseStaleMin()}m pass`,
        "without modification.",
      );
    }
    const held = readTreeLease(path);
    if (held === null) return;
    if (treeIsMine(held, ctx.session, ctx.actor, pr)) return;
    if (!leaseAlive(held)) return;
    if (held.holder === "worktree") {
      fail(
        11,
        `${label}: this working tree already has a sessionless resolver active on PR #${held.pr}.`,
        `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        "Refusing to post. A live sessionless resolver elsewhere in this tree is",
        "actively working, so proceeding here doubles every irreversible action",
        "from this point on — not repairable once it lands.",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease <pr>`,
        "Otherwise the tree's presence record clears itself once that resolver",
        `has left drive state untouched for ${leaseStaleMin()}m.`,
      );
    }
    fail(
      11,
      `${label}: this working tree is being driven from a live session other than this one (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
      `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Refusing to post. A live session elsewhere in this tree is actively",
      "working, so proceeding here doubles every irreversible action from this",
      "point on — not repairable once it lands.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease <pr>`,
      "Otherwise the tree lease clears itself once that session has left drive",
      `state untouched for ${leaseStaleMin()}m.`,
    );
  }
}
